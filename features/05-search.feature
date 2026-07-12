Feature: Item browse and search
  As a reader looking for information
  I want fast, scoped ways to browse and search items
  So that I can find the right knowledge without remembering exact titles

  Background:
    Given I am signed in as an administrator
    And the knowledge base contains published and draft items across multiple topics

  Scenario: Browse search filters the current results
    When I use the main browse search field
    Then the item list narrows to matching titles, body text, tags, and taxonomy metadata
    And I remain in the browse results page

  Scenario: Search results explain why an item matched
    Given matching items exist by title, body text, and metadata
    When I search from the browse page
    Then each matching card shows useful context for why it matched
    And unrelated items are not shown

  Scenario: Topic context scopes browse results
    Given I have selected a topic from the topic drawer
    When I browse or search items
    Then the results stay scoped to that topic
    And unrelated browse filters are preserved

  Scenario: Focused topic results are grouped for scanning
    Given I am browsing a topic with many items
    When the grouped browse view is shown
    Then items are grouped by primary category
    And the group navigation keeps the active group visible while I scroll

  Scenario: All-topic results are grouped by topic
    Given I am browsing all topics
    When the grouped browse view is shown
    Then items are grouped by topic
    And each group offers a way to focus on that topic

  Scenario: Global item lookup stays in the command palette
    When I open the command palette from the keyboard
    Then I can search across the knowledge base
    And choosing a result opens the item directly

  Scenario: The top bar does not duplicate browse search
    When I view the application header
    Then the header does not show a Search or Search pages control
    And the visible browse search remains in the browse controls

  Scenario: Search and browse perform at demo scale
    Given the knowledge base contains a large seeded demo corpus
    When I issue representative browse, search, and item-open actions
    Then the application remains responsive enough for daily use
