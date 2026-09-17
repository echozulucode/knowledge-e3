Feature: Pages maintained elsewhere, and changes that arrive from outside
  As someone reading and writing in an instance whose knowledge lives in several places
  I want the library to read as one library, and to be told plainly when a save is refused
  So that I send a change to the right place instead of discovering the refusal by saving

  Background:
    Given I am signed in as an administrator

  Scenario: A page whose file another team owns says that, and nothing more
    Given a published item whose source is a reference bundle
    When I open its read page
    Then it is marked as maintained elsewhere
    And the mark itself carries neither the source's identifier nor the path of its file

  Scenario: A page maintained elsewhere offers the original
    Given a published item whose source is a reference bundle with a known web address
    When I open its read page
    Then it offers to view the original
    And that offer opens the file on the host in a new tab

  Scenario: A page whose host has no web address makes the same claim without a link
    Given a published item whose source is a reference bundle with no derivable web address
    When I open its read page
    Then it is still marked as maintained elsewhere
    And no link to the host is offered
    And I am not told why there is no link

  Scenario: A page that cannot be edited here does not invite an edit that would be refused
    Given a published item whose source is read-only
    When I open its read page
    Then I am not offered to edit it here
    And I am told that changes to it are made by the team that owns it

  Scenario: A refused save is stated in the reader's words
    Given I am editing an item whose source is read-only
    When the save is refused
    Then I am told the page is maintained by another team and cannot be edited here
    And the refusal names no source identifier and no version control vocabulary

  Scenario: An edit to a file that changed outside the app reports what actually happened
    Given I am editing an item in Compose
    And the file behind it was changed in an editor outside the app
    When I save
    Then I am told that the file was changed outside the app and the index has not caught up
    And I am offered to reload the newer file
    And the version conflict comparison is not shown

  Scenario: A version conflict is still a version conflict
    Given I am editing an item in Compose
    And someone else saved a newer version of that item through the app
    When I save
    Then the version conflict comparison is shown
    And no changed-outside-the-app notice is shown

  Scenario: One library, however many places it lives in
    Given two items in two topics bound to two different sources
    And they share a tag and one links to the other
    When I search for a word they share
    Then both items are returned
    And when I open the tag both items are returned
    And when I open the linked item the other appears under Related
    And nothing on any of those screens names a repository, a mirror, a sync, or a source identifier

  Scenario: The properties a reader sees are an allow-list
    Given a published item carrying machine-written frontmatter keys
    When I open its read page and look at its properties
    Then I see only the properties chosen for a reader
    And the rest are behind a closed "Show all properties" disclosure

  Rule: An administrator can see where an item lives; a reader cannot

    Scenario: An administrator reads which repository and file an item comes from
      Given a published item whose canonical file was written into a registered source
      When I open its read page as an administrator and look at its properties
      Then I am shown the source's identifier and the path of its file
      And the same answer is shown in Compose's publish drawer

    Scenario: A signed-in reader is shown nothing about where the item lives
      Given a published item whose canonical file was written into a registered source
      When a signed-in reader opens its read page and looks at its properties
      Then no source identifier and no file path are shown
      And nothing else on the page tells them the library is spread over repositories
