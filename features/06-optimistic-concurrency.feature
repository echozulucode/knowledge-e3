Feature: Optimistic concurrency on item save
  As two authors editing the same item
  I want stale saves to be detected
  So that one author cannot silently overwrite another author's work

  Background:
    Given I am signed in as an administrator
    And a shared item exists

  Scenario: A normal save advances the item version
    When I save an edit based on the current item version
    Then the save succeeds
    And the item has a newer version

  Scenario: A stale save is rejected with current content
    Given another session has already saved the item
    When I try to save my older edit
    Then the save is rejected as a conflict
    And I can see the current server version information

  Scenario: The editor keeps unsaved local work visible after a conflict
    Given my save conflicts with a newer server version
    When the conflict is reported
    Then my unsaved edit remains in the editor
    And I am told the conflict needs attention

  Scenario: The author can inspect competing changes
    Given a save conflict exists
    When I choose to view the conflict details
    Then I can compare my edit with the current server content
    And I can decide what to do next

  Scenario: Overwriting uses the latest known version
    Given I decide my edit should replace the current server content
    When I confirm the overwrite
    Then the editor retries the save against the latest known version
    And my edit becomes the current item content

  Scenario: Cancelling a conflict does not silently merge content
    Given a save conflict exists
    When I cancel conflict handling
    Then the application does not auto-merge the two versions
    And I can return to the current server content intentionally
