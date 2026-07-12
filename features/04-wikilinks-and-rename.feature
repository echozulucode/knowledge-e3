Feature: Item links, backlinks, and rename safety
  As an author who builds knowledge by cross-linking items
  I want links and backlinks to survive normal editing and renaming
  So that the knowledge graph remains trustworthy

  Background:
    Given I am signed in as an administrator
    And the knowledge base contains multiple items

  Scenario: Wiki-links are extracted from prose only
    Given an item contains a wiki-link in prose
    And the same text appears inside code content
    When the item is saved
    Then only the prose wiki-link participates in the item graph

  Scenario: Stable Markdown links create backlinks
    Given one item links to another item using the target item's stable identity
    When I view the target item
    Then the backlink list includes the source item
    And the backlink preview shows the surrounding context

  Scenario: Backlinks are visible from the item read view
    Given an item has inbound links from other items
    When I expand the backlink section
    Then I can see the linking items and open them

  Scenario: Renaming an unreferenced item is simple
    Given an item has no inbound item links
    When I rename the item
    Then the new title is saved without asking for link-rewrite choices

  Scenario: Renaming a referenced item can update inbound wiki-links
    Given an item has inbound wiki-links from other items
    When I rename the item and choose to update references
    Then the affected links point to the new title
    And authored code content is left unchanged

  Scenario: Renaming can preserve existing link text
    Given an item has inbound links from another item
    When I rename the target item and choose not to rewrite links
    Then the source item remains unchanged
    And the backlink relationship can still be inspected when the link uses the target's stable identity

  Scenario: Rename conflicts do not partially update the graph
    Given another author changes a linked item during a rename
    When the rename cannot safely update all affected items
    Then no partial link rewrite is committed
    And the author is told the rename needs attention
