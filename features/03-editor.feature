Feature: Knowledge item editor
  As an author
  I want a focused Markdown-first editor for Knowledge E3 items
  So that I can update content and metadata without losing context or screen space

  Background:
    Given I am signed in as an administrator
    And a knowledge item exists

  Scenario: Edit mode focuses on the item body
    When I open the item for editing
    Then the editor fills the available work area
    And the item title and status remain available as edit metadata
    And the item properties start collapsed

  Scenario: Save and cancel remain available while editing
    Given I am editing a long item
    When I move through the editor content
    Then Save and Cancel stay fixed at the bottom of the edit screen
    And only one Save action set is shown

  Scenario: Properties are available on demand without using an eye icon
    Given I am editing an item with metadata
    When I reveal the item properties
    Then the properties are shown in the editor
    And the properties control uses a metadata-oriented icon rather than an eye icon

  Scenario: Existing items keep properties collapsed by default
    When I edit an existing item
    Then authoring starts with the body visible and properties hidden
    When I choose to show properties
    Then metadata can be reviewed without leaving edit mode

  Scenario: New items can be saved without exposing implementation details
    When I create a new item from the composer
    Then the item opens in edit mode with an editable title, status, topic, and body
    When I save the item
    Then the item returns to read mode with the authored content visible

  Scenario: The editor supports Markdown authoring modes
    When I switch between source, hybrid, and rich editing modes
    Then my item content remains equivalent
    And Markdown shortcuts continue to produce the intended formatting

  Scenario: Editor host services do not add a redundant page search box
    When I open the item editor
    Then there is no editor-local Search pages control
    And item links can still be represented as stable links to other items
