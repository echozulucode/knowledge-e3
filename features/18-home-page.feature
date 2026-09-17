Feature: The front page
  As the company running this instance
  I want the main page to be our publication's front page
  So that a visitor arrives at what we published, not at a door to it

  There is exactly one front page. The prototype's `?v=next`, `/home-next` and
  the "Classic home" link are gone along with the two layouts they compared:
  this product has never been used for real, so there is nothing to keep
  compatible and nothing redirects.

  Everything below is asserted as an anonymous visitor unless it says otherwise,
  because published knowledge is readable without an account and that visitor is
  the common case for a front page.

  Rule: The page is the tenant's, and the product's attribution is the colophon

    Scenario: The masthead carries the tenant's identity
      Given the instance has a configured name and logo
      When I open the front page
      Then the masthead shows that name and logo
      And neither the product's wordmark nor its taglines appear in the page

    Scenario: An unbranded instance still looks like a page
      Given the instance has no site configuration at all
      When I open the front page
      Then the masthead does not repeat the product name the rail already shows
      And the Updates feed starts at the top of the page

    Scenario: The attribution sits at the bottom, quietly
      When I open the front page
      Then "Powered by Knowledge x 10^3" appears once, in the colophon
      And the colophon is centred, in the smallest type, with no rule above it

    Scenario: The colophon is flush against the bottom of a short page
      Given the page's content does not fill the viewport
      When I open the front page
      Then the colophon's bottom edge is the bottom of the viewport
      And the free space is between the last block and the colophon

    Scenario: The colophon follows the content on a long page
      Given the page's content is taller than the viewport
      When I open the front page
      Then the colophon is below the fold, reached by scrolling
      And it does not overlay the content

  Rule: Search lives in the header, not on the front page

    Scenario: The front page has no search field of its own
      When I open the front page
      Then the page body has no search field
      And the header's search control reads "Search"

    Scenario: A newcomer is offered a place to start
      Given the home topic names a start-here item
      When I open the front page
      Then "Start here" is offered above the Updates feed
      And it opens that item
      But it is not offered when the home topic names no start-here item

    Scenario: The key topics lead to the full topic list
      Given topics are pinned
      When I open the front page
      Then "All topics" is offered under the key topics

    Scenario: The command palette ends on the search results page
      When I search from the command palette and choose to see all results
      Then I am on the search results page, not Browse

  Rule: The Updates feed is a cross-topic Section, not a second mechanism

    Scenario: The feed leads with the newest item
      Given a cross-topic Section resolving to several published items
      When I open the front page
      Then the newest item is a lead story and the next five are a list
      And they are ordered newest first
      And the heading is the Section's own name
      And "View all updates" opens that Section's own page

    Scenario: Each story carries one quiet metadata line
      Given a cross-topic Section resolving to published Blog Posts
      When I open the front page
      Then each row shows its title on up to two lines, its brief, and its topic, type, date and reading time on one line
      And the lead story's line names its topic and its author instead of its type
      And no content-type or trust chip is shown on any story

    Scenario: A story's topic label leads to the topic
      Given a story in the feed belongs to a topic
      When I choose the topic named on the story's metadata line
      Then I am on that topic's page, not the story's
      But a story whose topic has no known name shows no topic label

    Scenario: Covers invite the reader, and a missing cover is not a placeholder
      Given the newest story and one other story have covers, and a third does not
      When I open the front page without signing in
      Then the lead story's cover loads above its title
      And the other covered story's cover loads as a thumbnail beside its row
      And the story without a cover shows no image at all

    Scenario: An unverified story says nothing about trust on the front page
      Given the stories in the feed are unverified
      When I open the front page
      Then no story carries a trust label

    Scenario: An instance with nothing tagged still shows a feed
      Given no cross-topic Section resolves to anything
      When I open the front page
      Then the site-wide recent items are shown under "Recently published"
      And no heading claims curation nobody has done
      And its "view all" link opens Latest rather than claiming to be updates

    Scenario: Only an administrator is told how to curate one
      Given no cross-topic Section resolves to anything
      When an administrator opens the front page
      Then a quiet link offers to curate an updates feed
      But a reader is shown no setup instructions

  Rule: A small number of key topics can be pinned beside the feed

    Scenario: Pinned topics render with a colour and an optional cover
      Given an administrator has pinned topics with colours, one with a cover and one with an icon
      When I open the front page
      Then each pin shows the topic's name as text
      And every pin has the same thumbnail slot, holding the cover, else the icon
      And the colour is decoration on the card, never the only signal
      And the cover image loads for a visitor who is not signed in

    Scenario: Nothing pinned collapses to one column
      Given no topic is pinned
      When I open the front page
      Then no key-topics column is rendered and the feed takes the full width

    Scenario: The pin editor stops at the number of topics the page shows
      Given I am signed in as an administrator
      And five topics are pinned
      When I pin a sixth topic
      Then Pinned topics shows "6 of 6"
      And I cannot pin another, and I am told in text that six is the most the home page features

    Scenario: A dark theme cover needs a cover beside it
      Given I am signed in as an administrator
      When I edit a pin so it has a dark theme cover but no cover
      Then the pin says to set a cover before a dark theme cover
      And I cannot save the pin until it has one

    Scenario: An administrator pins a topic by choosing, not typing
      Given I am signed in as an administrator
      And an image has been uploaded to Files
      When I pin a topic, choosing its colour and icon by name and its cover from Files
      Then a preview of the card is shown in the light and dark theme before I save
      And the pin is saved with that colour, icon and cover

    Scenario: A topic cannot be pinned twice
      Given I am signed in as an administrator
      And a topic is pinned
      When I pin a topic
      Then the already-pinned topic is not offered

    Scenario: Reordering and unpinning save at once and can be undone
      Given I am signed in as an administrator
      And two topics are pinned
      When I move the second before the first
      Then the home page order is saved
      When I unpin a topic and confirm
      Then it is removed from the home page
      And undoing puts it back in its place

    Scenario: A pinned private topic is not published by pinning it
      Given an administrator has pinned a private topic
      When I open the front page without signing in
      Then that topic's name, description and cover are absent from the response

  Rule: The layout is driven by the page's own width, not by a device guess

    Scenario Outline: The page reflows without a horizontal scrollbar
      When I open the front page at <width> pixels wide
      Then nothing overflows horizontally

      Examples:
        | width |
        | 360   |
        | 768   |
        | 1024  |
        | 1440  |
        | 2560  |

    Scenario: A phone shows the key topics as a strip of chips above the feed
      When I open the front page on a phone-width screen
      Then the key topics are one row of compact chips above the Updates feed
      And the row scrolls sideways on its own, with the next chip partly in view
      And every chip can be reached from the keyboard
      And the page itself never scrolls sideways
      And Popular, when shown, comes after the feed

    Scenario: A tablet stacks the key topics under the feed as a grid
      When I open the front page on a tablet-width screen
      Then the key topics sit under the feed in more than one column

    Scenario: A wide screen keeps the feed and the key topics side by side
      When I open the front page on a laptop or a large monitor
      Then the key topics sit beside the feed in a single column
      And the feed is a single list that takes the wider share of the row
      And the content stops widening past 96rem, with the rest as margin
      But running prose keeps its reading measure

    Scenario: An ultrawide screen uses the capped width for a Popular column
      Given somebody has read a published item recently
      When I open the front page on a screen wide enough for three columns
      Then Updates, the key topics and Popular sit side by side, Updates the widest
      And Popular lists the most-read items with their rank, topic and reader count
      And the curated links, if any, sit under Popular instead of below the fold

    Scenario: Popular moves under the key topics when three columns do not fit
      Given somebody has read a published item recently
      When I open the front page on a laptop
      Then Popular sits under the key topics, beside the feed

    Scenario: On an extra-wide screen a story opens beside the feed
      Given a screen wide enough for the reading pane
      When I click a story in the Updates feed
      Then it opens in a reading pane taking roughly half the width
      And the Updates feed stays centred in the other half at the width it had
      And closing the pane returns the page to its centred layout
      # The full behaviour of the pane is in 19-reading-layout.feature.

    Scenario: Nothing read yet means no Popular column
      Given nobody has read anything in the window
      When I open the front page
      Then no Popular heading or empty column is shown

  Rule: Quiet text stays legible

    Scenario Outline: Metadata, briefs and the colophon meet AA contrast
      Given the <theme> theme
      When I open the front page
      Then the story metadata, the briefs and the colophon each contrast with their background at 4.5:1 or more
      And each story's metadata is visibly quieter and smaller than its brief

      Examples:
        | theme |
        | light |
        | dark  |

  Rule: A freshly seeded instance demonstrates the design

    Scenario: The seed populates the front page
      Given a database seeded by "just seed"
      When I open the front page
      Then an Updates section leads with the most recent story
      And the stories in it come from more than one topic
      And two to four topics are pinned beside it, with colours
      And some pins carry a cover image and the rest show their icon
      But no fake company name is configured
