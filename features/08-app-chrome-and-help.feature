Feature: Application chrome and keyboard help
  As a Knowledge E3 user
  I want navigation, help, and sidebar controls to stay simple
  So that I can focus on browsing and editing knowledge items

  Background:
    Given I am signed in as an administrator

  Scenario: The header offers one quick search
    When I view the application header
    Then I see the product identity and account/theme controls
    And I see a single Search control that opens the quick search
    And I do not see a second search control beside it

  Scenario: Help is a normal navigation destination
    When I open Help from the sidebar
    Then I am taken to the help page
    And keyboard shortcuts are shown as page content rather than a popup

  Scenario: Keyboard help can be opened from the keyboard
    When I use the keyboard shortcut for help
    Then I am taken to the help page
    And no keyboard-shortcuts dialog remains open

  Scenario: Quick search help entry routes to the help page
    When I open the quick search
    And I choose the keyboard shortcuts entry
    Then I am taken to the help page

  Scenario: Help explains how to search
    When I open the help page
    Then a "Searching" section lists every search filter with what it means and an example
    And it explains quoted phrases, excluding with a leading minus, and prefix matching
    And it defines the vocabulary: topic, content type, category, tag and trust tiers
    And it makes no mention of AI

  Scenario: Sidebar collapse uses directional affordances
    Given the sidebar is expanded
    Then the collapse control uses the angles-left icon
    When I collapse the sidebar
    Then the product mark becomes the control that expands it again
    And that control still names itself

  Scenario: Collapsing the sidebar preserves navigation meaning
    Given the sidebar is collapsed
    When I inspect the navigation controls
    Then each control still exposes an accessible name
    And I can expand the sidebar again
