Feature: Admin console layout and navigation
  As an administrator of this instance
  I want every admin page inside one console with grouped navigation and a short header
  So that I can find a destination quickly on any screen and see what needs attention first

  Decisions behind this file (Eric, 2026-09-13, the admin UX review §3.1, §4.9):
  - Admin navigation is a grouped left sub-nav inside the console, not horizontal tabs.
  - Every destination keeps its label; only the group headings are new words.
  - Every admin address that worked before still opens the same page.
  - The Overview never starts the library-wide content health report; it uses it only when already loaded.

  Background:
    Given I am signed in as an administrator

  Rule: The navigation is grouped and marks exactly one page as current

    Scenario: A wide console shows the destinations in named groups
      Given the admin console is wide
      When I open Admin then Users
      Then the navigation shows Overview, then People & access, Content and Operations
      And People & access offers Users, Authentication and Audit
      And Content offers Taxonomy, Sections and Files
      And Operations offers Data, Sources and Health
      And Users is marked as the current page

    Scenario: The sub-pages of a destination appear while it is open
      Given the admin console is wide
      When I open Admin then Taxonomy
      Then I am on Topics
      And Topics, Categories and Tags & groups are offered under Taxonomy

    Scenario Outline: Nested addresses mark the right sub-page
      When I open <address>
      Then <current> is marked as the current page
      And <not current> is not

      Examples:
        | address                | current       | not current   |
        | /admin/health          | Content       | System        |
        | /admin/health/system   | System        | Content       |
        | /admin/sections/pinned | Pinned topics | Sections      |
        | /admin/sections/new    | Sections      | Pinned topics |

    Scenario: Every existing admin address still opens its page
      When I open each admin address that existed before the console was grouped
      Then each opens its own page inside the console
      And each page shows the navigation exactly once

  Rule: The navigation fits the width the console has

    Scenario: A medium-width console keeps the navigation to one row
      Given the admin console is medium width
      When I open Admin then Health then System
      Then the destinations are one row that scrolls sideways instead of wrapping
      And Content and System are a second row beneath it

    Scenario: A phone shows a section switcher instead of the list
      Given I am on a phone
      When I open Admin then Topics
      Then a single "Admin › Topics" control is shown above the page
      And no navigation links are shown until I open it

    Scenario: The section switcher can be opened, dismissed and used
      Given I am on a phone
      And I am on Admin then Topics
      When I open the section switcher
      Then the grouped destinations are listed with Topics marked as current
      When I press Escape
      Then the list closes and focus returns to the switcher
      When I open the section switcher and choose System
      Then I am on System health
      And the list is closed

    Scenario: No admin page scrolls sideways on a phone
      Given I am on a phone 360 pixels wide
      When I open the Overview, Users, Topics, Sections, Content health and System health
      Then no page is wider than the screen

  Rule: The navigation flags trouble without extra cost

    Scenario: Sources shows how many conflicts are open
      Given a source has two open sync conflicts
      When I open any admin page
      Then Sources carries a badge reading 2
      And a screen reader hears "2 open conflicts" with it

    Scenario: Health is flagged while the instance is not healthy
      Given the system health verdict is Degraded
      When I open any admin page
      Then Health carries a "!" badge
      And a screen reader hears that the system is degraded

    Scenario: Nothing is flagged when nothing is wrong
      Given no source is in conflict
      And the system health verdict is Healthy
      When I open any admin page
      Then neither Sources nor Health carries a badge

    Scenario: A phone's closed switcher still says something needs attention
      Given I am on a phone
      And a source has open sync conflicts
      When I open Admin then Users
      Then the section switcher says something needs attention

  Rule: Each admin page opens with one compact header

    Scenario: A page header is a title, one sentence, and the main action
      When I open Admin then Taxonomy then Topics
      Then the page starts with the title and a one-sentence description
      And New Topic is at the top of the page, above the catalog
      And the longer explanation is behind "How this works"

  Rule: The Overview says what needs attention before offering shortcuts

    Scenario: Problems are listed worst first, each linked to where it is fixed
      Given a source has two open sync conflicts
      And the system health verdict is Degraded
      When I open the admin Overview
      Then "Needs attention" lists the open sync conflicts first, linked to Sources
      And it lists the Degraded verdict, linked to System health

    Scenario: A content health problem opens its own queue
      Given the content health report has already been run and items arrived with lint errors
      When I open the admin Overview
      Then "Needs attention" lists the items that arrived with lint errors
      And following it opens Content health on that queue

    Scenario: A clear instance says so
      Given no source is in conflict
      And the system health verdict is Healthy
      When I open the admin Overview
      Then "Needs attention" says "Everything looks healthy"
      And the content health report is not run to find out

    Scenario: Shortcuts mirror the navigation groups with counts the pages already have
      When I open the admin Overview
      Then "Needs attention" comes before the shortcuts
      And shortcuts are grouped as People & access, Content and Operations, side by side on a wide screen
      And People & access offers Users, Authentication, API tokens and Audit
      And Content offers Topics, Categories, Tags & groups, Sections and Files
      And Operations offers Data, Sources and Health
      And each shortcut uses its navigation label, opens the same page, and has a one-line description
      And Topics shows how many topics exist
      And API tokens shows how many tokens are active
      And a count the pages do not already load is left out rather than shown as zero

    Scenario: The Overview has no authentication-mode banner
      When I open the admin Overview
      Then no banner warns that authentication is disabled
      And this is on purpose: authentication can no longer be disabled

    Scenario: The Overview on a phone
      Given my screen is 360 pixels wide
      When I open the admin Overview
      Then the three shortcut groups stack in one column
      And nothing on the page scrolls sideways
