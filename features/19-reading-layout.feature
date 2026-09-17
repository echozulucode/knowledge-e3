Feature: Reading layout and the reading pane
  As a reader of mostly technical content
  I want every page centred at a comfortable width, articles a little wider than a novel,
  and, on an extra-wide screen, articles opening beside the list I found them in
  So that I read without excess wrapping and never lose my place in a list

  Decisions behind this file (Eric, 2026-09-13):
  - Centred is the one layout. The article page's old left-aligned column is gone.
  - Pages are "a little wider" than the old per-page caps (900-1100px): list,
    landing and utility pages cap their content at 85rem (1275px at this app's
    15px root size); multi-column pages (Home, Browse) at 96rem (1440px).
  - Article text is about 10% wider than before (128ch, up from 116ch), because
    the content is technical and excess wrapping hurts more than a long line.
  - The reading pane exists only on extra-wide screens, only shows an article or
    page, and for now is offered from Search and from the front page. Topic cards
    keep going to the topic page.

  Background:
    Given published articles exist, including one that links to another

  Rule: Every page is centred and held to a shared maximum width

    Scenario Outline: A list or landing page is centred at the page width
      Given a 1920 pixel wide screen
      When I open <page>
      Then its content is centred, with equal space on either side
      And its content is no wider than 85rem

      Examples:
        | page               |
        | Latest             |
        | the topics index   |
        | a topic landing    |
        | the search page    |

    Scenario: Multi-column pages use the wider cap
      Given a 1920 pixel wide screen
      When I open the front page
      Then its content is centred and no wider than 96rem

    Scenario: Prose inside a wide page keeps its reading measure
      When I open a page whose content includes running prose
      Then the prose lines stop at their own measure even when the page is wider

    Scenario: Nothing scrolls sideways on a phone
      Given a 390 pixel wide screen
      When I open any of these pages
      Then neither the page nor its scroll area overflows sideways

  Rule: An article is centred and a little wider than a novel

    Scenario: The article column is centred beside the context pane
      Given a 1440 pixel wide screen
      When I open an article
      Then the article column is centred in the space beside the context pane
      And its text is no wider than 128 characters

    Scenario: The article stays centred when the context pane is collapsed or stacked
      When I collapse the context pane
      Then the article column is still centred in the space it has
      And on a narrower screen where the context pane stacks below, it is centred there too

    Scenario: Wide technical content scrolls inside its own box
      Given an article with a wide table and a long code block
      When I open it
      Then the table and the code block each scroll sideways within the article column
      And the page itself does not scroll sideways
      And a long unbroken URL wraps rather than being cut off

  Rule: On an extra-wide screen an article opens in a reading pane beside the list

    The pane appears only when the page has at least 110rem of width to give it
    (1650px at this app's root size), measured on the space the page actually has,
    so an expanded sidebar can hold it back. Below that nothing changes.

    Scenario: A search result opens beside the results
      Given an extra-wide screen
      And the search page is showing results
      When I click a result
      Then the article opens in a reading pane on the right
      And the results stay visible on the left, with the chosen result marked as current
      And the address carries the open article
      And focus moves to the article's title

    Scenario: A front page story opens beside the Updates feed
      Given an extra-wide screen
      When I click a story in the Updates feed or in Popular
      Then the story opens in the reading pane

    Scenario: The pane takes half the space and the list keeps its width
      Given an extra-wide screen
      And the front page is open
      When I open a story in the reading pane
      Then the reading pane takes roughly half the width
      And the Updates feed stays centred in the other half
      And it is no wider than it was with the pane closed
      And the key topics and Popular sit below the feed instead of beside it

    Scenario: Closing the pane puts the list back as it was
      Given a story is open in the reading pane on the front page
      When I close the pane
      Then the Updates feed returns to the centre at the width it had before

    Scenario: Choosing another result switches the pane
      Given an article is open in the reading pane
      When I click a different result
      Then the pane shows that article instead
      And the pane starts at the top of the new article

    Scenario: The pane closes from the keyboard or its button
      Given an article is open in the reading pane
      When I press Escape, or choose "Close reading pane"
      Then the pane closes
      And focus returns to the result I opened it from

    Scenario: Escape leaves a text field alone
      Given an article is open in the reading pane
      And focus is in the search box
      When I press Escape
      Then the pane stays open

    Scenario: The article can be opened as a full page
      Given an article is open in the reading pane
      When I choose "Open full page"
      Then the article's own page opens
      And going back returns to the list with the pane open

    Scenario: Links inside the pane stay in the pane
      Given an article that links to another is open in the reading pane
      When I follow that link
      Then the linked article opens in the same pane
      And going back returns to the first article

    Scenario: Back, Forward and reload keep the pane's state
      Given I opened an article in the reading pane and then closed it
      When I go back
      Then the pane is open on that article again
      And going forward closes it
      And reloading the page with an article open restores the pane

    Scenario: A filter or sort change keeps the pane open
      Given an article is open in the reading pane from the search page
      When I change the sort order
      Then the results update and the pane stays open on the same article

    Scenario: New-tab clicks still belong to the browser
      Given an extra-wide screen
      When I Ctrl-click or middle-click a result
      Then the article opens the way the browser normally opens a link
      And no reading pane opens

    Scenario: Opening an article in the pane counts one view
      Given I am signed in
      When I open an article in the reading pane
      Then one page view is recorded for it, as if I had opened its page

    Scenario: Topic cards still go to the topic page
      Given an extra-wide screen
      When I click a key topic card on the front page
      Then the topic's landing page opens, not a reading pane

  Rule: Below the threshold nothing changes

    Scenario: A normal screen opens the article page
      Given a 1440 pixel wide screen
      When I click a search result
      Then the article's own centred page opens
      And no reading pane is shown

    Scenario: A shared pane link on a narrow screen lands on the article
      Given a link to the search page with an article open in the reading pane
      When I open it on a 1440 pixel wide screen
      Then I land on that article's own page
