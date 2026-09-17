Feature: Topic landing pages by presentation profile
  As a reader arriving at a topic
  I want a landing page shaped for that topic's purpose
  So that I can find the guidance, examples, and latest items without reading a document

  Background:
    Given published items of several content types exist in a topic

  Scenario: The topics index lists every visible topic
    When I open the topics index
    Then each visible topic appears as a tile with its name, description, item count, and presentation
    And choosing a tile opens that topic's landing page

  Scenario: A portal topic renders its Section slots in gateway order
    Given the topic's presentation is "portal"
    And a Section with slot "essential" resolves to published items
    When I open the topic's landing page
    Then the "Essential guidance" slot lists those items with their type, freshness, and trust
    And a "Get started" button opens the topic's start-here item when one is set

  Scenario: An empty slot disappears
    Given the topic's presentation is "portal"
    And a Section with slot "limitations" resolves to no published items
    When I open the topic's landing page
    Then no "Known limitations" heading is shown

  Scenario: A blog topic renders a feed
    Given the topic's presentation is "blog"
    When I open the topic's landing page
    Then the topic's published posts are listed newest first
    And an Atom feed link for the topic is offered

  Scenario: A docs topic offers its Sections as a sub-navigation
    Given the topic's presentation is "docs"
    When I open the topic's landing page
    Then the Sections are listed in a side navigation in their configured order
    And each Section's items are listed alongside

  Scenario: A wiki topic keeps the counts and a way into browse
    Given the topic's presentation is "wiki"
    When I open the topic's landing page
    Then I see the topic's description and item counts
    And I can open browse filtered to that topic

  Scenario: A topic page offers a search within the topic
    When I open the topic's landing page
    Then I see a "Search in <topic>" box
    And searching from it opens the search page limited to this topic

  Scenario: A topic page shows this topic's updates, newest first
    Given the site has an updates feed that gathers items by tag
    And items in this topic and in another topic carry that tag
    When I open the topic's landing page
    Then the updates block lists only this topic's tagged items, newest first
    And each shows its title, brief, date and reading time without naming the topic
    And a link opens every update in this topic

  Scenario: A topic with nothing tagged shows what was recently updated instead
    Given no item in the topic carries the updates tag
    And the topic's presentation is not "blog"
    When I open the topic's landing page
    Then a "Recently updated" block lists the topic's newest published items

  Scenario: A topic page shows what readers in it open most
    Given at least three published items in the topic were opened by signed-in readers in the last 30 days
    When I open the topic's landing page
    Then a "Popular in" list ranks those items by how many different readers opened them
    And each shows how many readers it had, never who they were

  Scenario: Too little reading to rank shows no popular list
    Given fewer than three items in the topic were opened in the last 30 days
    When I open the topic's landing page
    Then no "Popular in" list is shown

  Scenario: A private topic is not found for a visitor
    Given the topic is private
    When I open the topic's landing page without signing in
    Then I am told the topic was not found

  Scenario: An administrator finds topics in the Admin catalog
    Given I am signed in as an administrator
    And some topics are private and some have no items
    When I open Topics in Admin
    Then each topic shows its name, description, presentation, visibility and item count
    And the home topic and pinned topics are marked
    And I can narrow the list to private topics or to empty topics, and search it by name
    And the narrowed list can be shared as a link

  Scenario: An administrator sets the presentation profile
    Given I am signed in as an administrator
    When I open the topic's edit page in Admin
    And I choose a presentation, pick a start-here item from the topic's published items, and write landing markdown
    And I preview the landing markdown before saving
    And I save the topic
    Then the landing page renders with that profile
    And its Get started button opens the item I picked

  Scenario: An administrator creates a private topic
    Given I am signed in as an administrator
    When I create a topic in Admin and choose Private
    Then the topic is created private
    And its edit page opens
    And a visitor who is not signed in is told the topic was not found

  Scenario: Making a private topic public is confirmed first
    Given I am signed in as an administrator
    And a private topic has published items
    When I choose Public on the topic's edit page
    Then I am asked to confirm, and told how many published items become readable by anonymous visitors
    And the topic stays private until I confirm and save

  Scenario: A topic with items cannot be archived
    Given I am signed in as an administrator
    And a topic has items assigned to it, even if they are only drafts
    When I look for Archive on that topic in Admin
    Then Archive is unavailable and says how many items the topic has

  Scenario: An empty topic is archived after confirming
    Given I am signed in as an administrator
    And a topic has no items
    When I archive it in Admin and confirm
    Then the topic leaves the catalog
    And its landing page address stops working

  Scenario: A topic bound to a repository starts private unless I choose otherwise
    Given I am signed in as an administrator
    And I am creating a topic in Admin
    When I enter a repository URL for it
    Then Private is preselected
    And I am told why: so content pulled from the repository is not visible to anonymous visitors before it is reviewed
    When I choose Public instead and create the topic
    Then the topic is created public
