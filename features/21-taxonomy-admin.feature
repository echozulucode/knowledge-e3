Feature: Tags, groups and primary categories in the admin console
  As an administrator of this instance
  I want to see how tags are used, and to keep groups and primary categories tidy
  So that readers can filter by terms that mean something and authors publish into a curated catalog

  Decisions behind this file (Eric, 2026-09-13, the admin UX review §4.6):
  - Tags come from item frontmatter; renaming and merging them is not offered until a reviewed rewrite exists, and the page says so once instead of showing disabled buttons.
  - Groups and primary categories are archived, never deleted, and not while items are filed under them.
  - Archiving a primary category can be undone; a group's slug and a category's slug never change after creation.

  Background:
    Given I am signed in as an administrator

  Rule: Tags show their usage and nothing that cannot be done

    Scenario: The tag list offers no rename or merge actions
      Given items carry tags
      When I open Tags & groups
      Then I see each tag with how many items carry it
      And I am told that renaming and merging tags isn't available yet
      And no tag offers an action that cannot be taken

    Scenario: The most used tags come first, and I can sort by name instead
      Given a tag carried by three items and a tag carried by one item
      When I search Tags & groups for those tags
      Then the tag carried by three items is listed first
      When I sort by name
      Then the tags are listed alphabetically

    Scenario: I can list only the tags a single item uses
      Given a tag carried by three items and a tag carried by one item
      When I search Tags & groups for those tags
      And I choose "Used by only 1 item"
      Then only the tag carried by one item is listed

    Scenario: A tag's item count leads to those items
      Given a tag carried by three items
      When I follow the tag's item count
      Then search lists the items carrying that tag

    Scenario: A long tag list is shown fifty at a time
      Given 55 tags match my search
      Then the first 50 are listed with "1–50 of 55"
      When I go to the next page
      Then the remaining 5 are listed

  Rule: The page remembers whether I am looking at tags or groups

    Scenario: A link to the groups view opens the groups view
      When I switch Tags & groups to Groups
      And I reload the page
      Then Groups is still the selected view
      And New group is offered at the top of the page

  Rule: Groups are created and edited in one dialog

    Scenario: A new group can be limited to one topic
      Given a topic named "Research Lab"
      When I create a group named "Review Board" available in "Research Lab"
      Then the group list shows "Review Board" available in "Research Lab"

    Scenario: Editing a group can make it available in all topics
      Given a group available only in "Research Lab"
      When I edit the group and choose All topics
      Then the group list shows it available in All topics
      And its slug is unchanged

    Scenario: A group that items are in cannot be archived
      Given a group one item is in
      When I open the group's actions
      Then Archive is unavailable with the reason "In use by 1 item"

    Scenario: An unused group is archived after I confirm
      Given a group no item is in
      When I archive the group and confirm
      Then it no longer appears in the group list

  Rule: Items join the group that owns the name they give

    Scenario: An item naming a group limited to one topic is counted in that group
      Given a group "Lab Operators" available only in "Research Lab"
      When an author saves an item in "Research Lab" that names the group "lab-operators"
      Then the group list shows "Lab Operators" with 1 item
      And searching within the group "lab-operators" finds the item

    Scenario: An item naming an archived group is flagged, and the group stays archived
      Given an archived group "Night Watch"
      When an author saves an item that names the group "night-watch"
      Then the item is saved and is in "Night Watch"
      And checking the item reports a warning, not an error, that the group "night-watch" is archived
      And "Night Watch" still does not appear in the group list

  Rule: Primary categories are curated, and archiving one can be undone

    Scenario: A new primary category is created from the page header
      When I create a primary category named "Field Notes"
      Then the catalog lists "Field Notes" with the slug "field-notes" and no items

    Scenario: Renaming a primary category keeps its slug and its items
      Given a primary category "Field Notes" that one item is filed under
      When I rename it to "Customer Field Notes"
      Then the catalog lists "Customer Field Notes" with the slug "field-notes"
      And the item is found by searching for "Customer Field Notes"

    Scenario: A primary category that items are filed under cannot be archived
      Given a primary category that one item is filed under
      When I open the category's actions
      Then Archive is unavailable with the reason "In use by 1 item"

    Scenario: Archiving an unused primary category can be undone
      Given a primary category no item is filed under
      When I archive it and confirm
      Then it leaves the catalog
      When I choose Undo on the confirmation message
      Then it is back in the catalog

    Scenario: An archived primary category can be restored later
      Given an archived primary category
      When I open the Archived view and restore it
      Then it is back in the catalog
