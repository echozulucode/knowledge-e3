Feature: Audit log, telemetry, and reliability primitives
  As the maintainer of a small Knowledge E3 deployment
  I want important actions to be observable and recoverable
  So that I can diagnose problems and trust write history

  Background:
    Given I am signed in as an administrator

  Scenario: Item writes are audit logged
    When an item is created, updated, renamed, or deleted
    Then the audit log records the action
    And the entry identifies the actor and affected item

  Scenario: Audit entries are append-only
    Given audit entries already exist
    When normal application traffic continues
    Then previous audit entries are not changed or removed

  Scenario: Item views are counted
    When I open an item in the browser
    Then an item-view event is recorded for that item
    And the event can be associated with the current user when signed in

  Scenario: Bug reports can include context
    When a user submits a bug report with context
    Then the report is stored for triage
    And authenticated reports are associated with the reporter

  Scenario: Production logs are structured
    Given the server runs in production mode
    When requests are handled
    Then log lines are machine-readable
    And related log entries share a request correlation identifier

  Scenario: Development logging remains readable
    Given the server runs in local development mode
    When requests are handled
    Then logs are easy for a developer to read
    And request correlation remains visible

  Scenario: Health checks do not flood request logs
    When infrastructure probes health endpoints repeatedly
    Then those checks do not dominate the request log

  Scenario: Error reporting is inert without credentials
    Given external error-reporting credentials are not configured
    When the application starts
    Then no external error-reporting client is initialized

  @pending
  Scenario: Configured error reporting captures unhandled exceptions
    Given external error reporting is configured
    When an endpoint fails unexpectedly
    Then the exception is reported with useful context
    And private details are not exposed to the caller

  Scenario: A failed sign-in names an anonymous actor and the username tried
    Given someone fails to sign in as "bob"
    When I read the audit log
    Then the entry's actor reads "(anonymous)"
    And its summary says the sign-in was attempted as "bob" and from where
    And it is not attributed to the system

  Scenario: An entry by an account that no longer exists says so
    Given an audit entry was written by an account that has since been removed
    When I read the audit log
    Then the entry's actor reads "deleted account"

  Scenario: Audit date filters use the administrator's own days
    Given an audit entry was written late in the evening of my local day
    When I filter the audit log from and to that day
    Then the entry is included
    And the page names the timezone its dates and times are in

  Scenario: Each entry says what happened in a sentence
    Given alice promoted bob from user to admin
    When I read the audit log
    Then the entry shows the action code "user.role_change" as written
    And its summary reads "bob: user → admin"

  Scenario: Audit filters apply at once and are kept in the address
    When I choose an action and "Last 24 hours" in the audit log
    Then the entries narrow without pressing a button
    And each active filter is listed with a way to remove it
    And reloading the page keeps the same filters

  Scenario: I can see what was done to an account, not only what it did
    Given alice promoted bob and later reset bob's password
    And someone failed to sign in as "bob"
    When I filter the audit log by the subject "bob"
    Then those three entries are listed
    And entries where bob was the one acting are not

  Scenario: An entry opens to its full detail
    When I expand an audit entry
    Then I see who acted and what was acted on, each with a way to filter by it
    And I see the exact time in my timezone and in UTC
    And I see the recorded details as they were stored, with Copy JSON
    And I can copy a link that opens just that entry

  Scenario: The filtered audit log can be exported
    Given I have filtered the audit log
    When I export it as CSV or JSON
    Then the file holds exactly the entries that match the filters
    And a spreadsheet opening the CSV treats every cell as text, never as a formula

  Scenario: A very large export says it was cut short
    Given more audit entries match my filters than one export may hold
    When I export them
    Then the newest entries up to the limit are exported
    And I am told the export stopped at the limit

  Scenario: Secrets never appear in the audit log
    When an API token is created or revoked, or a password is reset
    Then the entry names the token or the account
    But no token value, token prefix or password appears in the entry, its summary or an export
