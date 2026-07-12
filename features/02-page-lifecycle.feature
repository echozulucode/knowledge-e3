Feature: Item lifecycle and taxonomy
  As a signed-in knowledge worker
  I want to create, read, update, classify, and recover knowledge items
  So that useful information stays discoverable and maintainable

  Background:
    Given I am signed in as an administrator

  Scenario: Create a new item from the browse page
    When I start a new item
    And I provide a title and initial body
    Then the draft item is created
    And I can immediately continue editing it

  Scenario: New items inherit the active topic context
    Given I am browsing a specific topic
    When I create a new item
    Then the item starts in that topic
    And I can choose a different topic before saving

  Scenario: Item title is separate from body headings
    Given I am editing an item
    When I change the item title
    Then the item's identity changes
    And authored headings in the body are not silently rewritten

  Scenario: Read view shows content before optional metadata
    Given a published item has body content and properties
    When I open the item
    Then the title and body are visible
    And the properties are hidden until I ask to see them

  Scenario: Editing preserves taxonomy metadata
    Given an item belongs to a topic, category, group, and tags
    When I edit and save the body
    Then the taxonomy metadata remains associated with the item

  Scenario: Editing can move an item between topics
    Given an item belongs to one topic
    When I choose another topic while editing
    Then the item appears in the new topic browse results
    And it no longer appears as a member of the old topic

  Scenario: Duplicate titles are rejected within the same topic context
    Given an item already has a title
    When I try to create another item with the same title in the same context
    Then I am told the title is already in use
    And the existing item is not overwritten

  Scenario: Deleted items leave normal browse results
    Given an item is no longer needed
    When I delete it
    Then it no longer appears in normal browse and search results
    And recovery remains possible during the retention window

  Scenario: Version history records item saves
    Given an item has been saved multiple times
    When I view its history
    Then I can see the previous saved versions
    And older versions are read-only unless a restore flow is explicitly chosen
