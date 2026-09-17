Feature: Compose surface and publish drawer
  As a signed-in author
  I want a focused writing surface with everything else in a publish drawer
  So that writing a post feels like a blog editor rather than a wiki form

  Background:
    Given I am signed in as an administrator

  Scenario: Create a blog post from the compose page with the publish drawer
    When I open the compose page for a new blog post
    Then the body is pre-filled with the blog post template
    When I enter a title
    And I open the publish drawer
    And I choose a primary category, a description, an author, and a published date
    And I publish
    Then I am taken to the published read page
    And the item is published with the drawer's metadata

  Scenario: Autosave marks the draft as saved
    Given I am composing a new item with a title
    When I type in the body and stop
    Then the draft is created without pressing Save
    And the save status reads Saved

  Scenario: Publishing requires exactly one primary category
    Given I am composing a new item with a title and a description
    When I open the publish drawer without choosing a primary category
    Then Publish is disabled
    And I am told to choose exactly one primary category
    When I choose a primary category
    Then Publish is enabled

  Scenario: Marking content as reviewed records a human verification
    Given an existing draft item that is ready to publish
    When I open it in the compose page
    And I open the publish drawer
    And I confirm that I reviewed this content
    And I publish
    Then the item's frontmatter carries a verified entry by me

  Scenario: Editing an existing item opens the compose page
    Given an existing item
    When I open its read page and choose Compose
    Then I am taken to the compose page for that item
    And the title and body are loaded for editing

  Scenario: Read pages show trust and freshness badges
    Given an existing item with no verification
    When I open its read page
    Then I see an Unverified trust badge next to the content type

  Scenario: A publish the server refuses says what to fix and changes nothing
    Given an existing draft whose primary category this instance does not know
    When I open it in the compose page
    And I open the publish drawer and publish
    Then I am told the item cannot be published yet
    And each content-model error is listed against the frontmatter key it belongs to
    And I am told the item is unchanged and nothing was saved
    And the item is still a draft
    And I am offered the publish drawer again to fix it
