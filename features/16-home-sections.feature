Feature: Custom updates on the front page
  As the company running this instance
  I want to say which items are our updates, rather than only which have aged out
  So that the front page shows what we chose to put there

  The site-wide "What's new" list is opt-out: a curator can age an item out of it
  but cannot nominate a set. A Section on the home topic, filtered to the tags the
  curator names, is how they nominate one — reusing Sections rather than adding a
  parallel curation mechanism.

  There is one front page and a topic's presentation profile does not change its
  shape. Where a Section lands on it is decided by the Section: the cross-topic
  Section with the lowest order becomes the Updates feed at the top, and every other
  Section renders below the fold under its slot's heading. A fresh instance is
  seeded with one such Section, named "Updates" and filtered to the tag "update";
  its name is the feed's heading, so a tenant can rename it.

  Background:
    Given published items carry tags such as "update" and "release"

  Scenario: A tag-filtered Section appears on the front page
    Given a Section on the home topic filtered to the tags "update", "release" and "announcement"
    When I open the front page
    Then that Section is listed under its slot's heading
    And it contains the published items carrying any of those tags, newest first
    And its description is shown above the items

  Scenario: The tag filter narrows alongside the type and topic filters
    Given a Section on the home topic filtered to type "Blog Post" and the tag "update"
    When I open the front page
    Then an item of another type carrying "update" is not listed
    And an item in another topic carrying "update" is not listed
    And a "Blog Post" in that topic with no tags is not listed

  Scenario: A tag nobody has used yet is not an error
    Given a Section on the home topic filtered to a tag no item carries
    When I open the front page
    Then that Section is not shown at all
    And the rest of the front page renders normally

  Scenario: Unpublished items stay off the front page
    Given a draft item in the home topic carrying the Section's tag
    When I open the front page
    Then that draft is not listed in the Section

  Scenario: An administrator sets the tags without editing a config file
    Given I am signed in as an administrator
    When I create a Section in Admin and choose its tags from the tags already in use
    Then the Section is saved with those tags
    And reopening the Section shows the tags it draws from

  Scenario: Every field of the Section editor is labelled
    Given I am signed in as an administrator
    When I start a new Section in Admin
    Then its name, URL, description, content type, topic, tags, slot and max items fields each carry their own label

  Scenario: A Section with no topic spans every topic
    Given published items tagged "update" exist in several topics
    And a Section with no topic filtered to the tag "update"
    When I open the front page
    Then that Section lists the tagged items from every topic, newest first

  Scenario: The cross-topic Section with the lowest order leads the page
    Given two Sections with no topic and different orders
    When I open the front page
    Then the lower-ordered one is the Updates feed at the top of the page
    And the other renders below the fold under its slot's heading

  Scenario: A cross-topic Section stays off the topic landing pages
    Given a Section with no topic filtered to the tag "update"
    When I open a topic's landing page
    Then that Section is not shown there
    And the sections naming that topic are still shown

  Scenario: A cross-topic Section does not expose a private topic to a visitor
    Given an item tagged "update" is published in a private topic
    And items tagged "update" are published in public topics
    And a Section with no topic filtered to the tag "update"
    When I open the front page without signing in
    Then the items from the public topics are listed
    But the item from the private topic is not listed

  Scenario: A signed-in reader still sees the private topic's item
    Given an item tagged "update" is published in a private topic
    And a Section with no topic filtered to the tag "update"
    When I open the front page signed in
    Then the item from the private topic is listed

  Scenario: A Section below the fold does not replace the Updates feed
    Given a Section on the home topic filtered to the tag "update"
    And a cross-topic Section with a lower order
    When I open the front page
    Then the Updates feed still leads the page above it

  Rule: Sections are listed read-only and edited one at a time

    Background:
      Given I am signed in as an administrator

    Scenario: The list shows where each Section appears
      Given Sections on the front page and on a topic
      When I open Sections in Admin
      Then the front-page Sections are listed together, apart from each topic's
      And no Section can be changed from the list itself

    Scenario: The list names the front page's lead
      Given two front-page Sections, and the lower-ordered one matches no items
      When I open Sections in Admin
      Then the other one is marked as the lead
      And the empty one says it is hidden on the site because it matches no items

    Scenario: The editor previews what a Section will show
      Given two published items carry a tag
      When I create a Section filtered to that tag
      Then the preview says it matches 2 items and lists them
      And it says where the Section will appear

    Scenario: A Section with no matches can still be saved
      When I create a Section filtered to a tag no item carries
      Then I am warned it is hidden on the site until an item matches
      But I can still save it

    Scenario: Two Sections cannot share a URL
      Given a Section already uses a URL
      When I give a new Section a name that makes the same URL
      Then I am told another Section already uses it
      And the new Section is not created

    Scenario: Changing a Section's URL is deliberate
      Given a saved Section
      When I open it in Admin
      Then its URL cannot be edited until I choose to change it
      And choosing to change it warns me that existing links to it will break

    Scenario: A Section changed by someone else is not silently overwritten
      Given I opened a Section and another administrator then saved a change to it
      When I save my version
      Then I am told it changed since I opened it
      And I can reload their version or overwrite it with mine

    Scenario: Reordering saves at once and can be undone
      Given two front-page Sections
      When I move the second above the first with the keyboard
      Then the new order is saved
      And undoing puts the old order back

    Scenario: Deleting a Section is confirmed and can be undone
      Given a Section
      When I delete it from the list
      Then I am told what deleting it changes before anything is removed
      And after I confirm it is gone
      And undoing brings it back
