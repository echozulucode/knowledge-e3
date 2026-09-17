Feature: Local read-only MCP server
  As someone who wants an AI agent to use my knowledge without handing it the whole machine
  I want a local MCP server that reads only the folders, repositories and knowledge servers I configure
  So that the agent can search and read that knowledge, and nothing else, and can never change it

  Background:
    Given a local MCP server configured with a notes folder, a handbook git repository and the intranet knowledge server

  Scenario: Only configured sources are reachable
    When the agent lists the sources
    Then it sees the notes folder, the handbook repository and the intranet server, and no other source
    And a file outside those folders is never returned, even when a link inside a folder points to it
    And an item reference that looks like a file path finds nothing

  Scenario: The server offers reading tools only
    When the agent lists the tools
    Then it can search, read an item, list topics, taxonomy, content types and sources, validate a draft, and re-read local files
    And there is no tool to create, update, publish, import or export content
    And the tool names and arguments are the ones the intranet knowledge server offers

  Scenario: Search is keyword search
    Given the notes folder has an item titled "Pump Restart Runbook" that mentions the modbus controller
    When the agent searches for "modbus"
    Then the runbook is found, with an excerpt that marks where "modbus" matched
    And a search for "restarted" does not find it, because words are not stemmed or approximated
    And the same filters work as on the intranet server, such as tag, type, topic, author, updated and is

  Scenario: Drafts stay hidden until asked for
    Given the notes folder has a draft item
    When the agent searches without asking for drafts
    Then the draft is not returned
    When the agent searches asking for drafts
    Then the draft is returned

  Scenario: Results from different sources are never ranked together
    Given the notes folder and the intranet server both have items about pumps
    When the agent searches for "pump"
    Then the results come back grouped by source, each group in that source's own order with its own count
    And every result names its source and carries a reference qualified by that source
    And reading an item by that reference returns the item from that source only

  Scenario: An ambiguous item reference is refused rather than guessed
    Given the notes folder and the handbook both have an item titled "Deploy Guide"
    When the agent asks for "Deploy Guide" without naming a source
    Then the request is refused as ambiguous
    And the refusal lists the source-qualified references to choose from

  Scenario: A repository is pulled at start only when that is safe
    Given the handbook repository is configured to pull at start
    And the repository has no local changes and its branch can be fast-forwarded
    When the local MCP server starts
    Then the handbook is fast-forwarded and its new items are searchable
    But when the repository has local changes, or has diverged from its upstream, it is not pulled
    And its working tree is served as it is, with a warning in the server log

  Scenario: A repository configured for manual pulls is never pulled
    Given the handbook repository is configured with manual pulls
    When the local MCP server starts
    Then the remote is not contacted and the working tree is served as it is

  Scenario: The personal access token never leaves the environment variable
    Given the intranet server's token is kept in an environment variable named in the configuration
    When the agent searches and the intranet server accepts the token
    Then the token is sent only to the intranet server
    And the token does not appear in any result, error or log line, and neither does its length
    And the agent can see only whether a token is set

  Scenario: A token in the configuration file is refused
    Given the configuration file contains a token value
    When the local MCP server starts
    Then it does not start
    And the error explains that tokens belong in an environment variable, without repeating the value

  Scenario: A refused token is reported without failing the other sources
    Given the intranet server rejects the token
    When the agent searches every source
    Then the notes and handbook results are returned
    And the intranet group reports that the intranet server refused the request, naming the source and not the token
    When the agent searches only the intranet server
    Then the search fails with that same explanation

  Scenario: The protocol channel carries only protocol messages
    When the local MCP server runs
    Then everything it writes to standard output is an MCP message
    And its log lines go to standard error
