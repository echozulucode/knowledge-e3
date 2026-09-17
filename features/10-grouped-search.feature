Feature: Grouped search with lifecycle and trust labels
  As a reader looking for the right kind of item
  I want search results grouped by content type, with a quiet line of facts and a label only when something is unusual
  So that I can tell a current runbook from a stale note or a draft before I open it

  Background:
    Given I am signed in as an administrator
    And published items of several content types match a search term

  Scenario: The command palette groups results by content type
    When I open the command palette from the keyboard
    And I search for the term
    Then the results are grouped under one heading per content type
    And each heading offers a way to see all results of that type
    And every result shows its topic, content type and last update on one quiet line
    And a trust mark appears only when the item is verified
    And a published result carries no status, recency or match-reason labels

  Scenario: A stale item is labelled Needs review
    Given a matching item is past its stale-after date
    When I search for the term in the command palette
    Then that result is labelled "Needs review"
    And fresh results carry no freshness label

  Scenario: Keyboard selection walks the groups in visual order
    Given the command palette shows grouped results
    When I press the down arrow repeatedly
    Then the highlighted result moves through every group in the order shown
    And pressing Enter opens the highlighted result

  Scenario: Enter in the quick search opens every result on the search page
    Given the command palette shows grouped results
    And I have not moved the highlight
    When I press Enter
    Then I am taken to the search page with my search term

  Scenario: See all opens the filtered search results
    Given the command palette shows grouped results
    When I choose "See all" for one content type
    Then I am taken to the search page with the search term and that content type applied
    And only items of that content type are listed

  Scenario: Browse can show results grouped by type
    When I open browse with the "By type" layout in the URL
    Then the results are grouped under one heading per content type
    And each result shows its content type as text, and a trust mark only when the item is verified
    And the "By type" layout toggle is active

  Scenario: The sidebar offers the durable destinations
    When I view the sidebar
    Then it offers Home, Topics, Latest, Review, Sections and Search in that order
    And Review is shown because I am an administrator
    And it does not offer Browse or Tags
    And choosing Topics takes me to the topics index
    And choosing Latest takes me to the latest feed
    And choosing Search takes me to the search page

  Scenario: A shared search link opens on its results
    When I open the search page with the term in the address
    Then the term is already in the search box
    And the results are grouped under one heading per content type
    And each heading offers a way to see all results of that type on the search page

  Scenario: A result opens the item and Back returns to the results
    Given the search page is showing grouped results
    When I choose one result
    Then that item's page opens
    And going back returns to the same results with the term still in the box
    And going forward opens that item again

  Scenario: Refining a search costs one history entry
    Given I arrived at the search page from elsewhere
    When I type a term into the search box
    Then the results narrow to that term
    And going back leaves the search behind rather than rewinding it a character at a time

  Scenario: A content-type chip narrows the results
    Given the search page is showing grouped results
    When I choose the chip for one content type
    Then only results of that content type are listed
    And the chips for the other content types are still offered
    And choosing the same chip again restores every group

  Scenario: A result on the search page is its title, a snippet and one line of facts
    Given the search page is showing grouped results
    Then each published result shows its topic, content type and last update on one quiet line
    And it carries no content-type, status, recency or match-reason labels

  Scenario: A draft result says it is a draft
    Given a matching item I wrote is still a draft
    When I search for the term on the search page
    Then that result is labelled "Draft"
    And the published results carry no status label

  Scenario: A search that matches nothing explains itself
    Given no item matches the term
    When I search for the term
    Then I am told there are no matches for it
    And I am given suggestions for searching differently
    And I am offered the whole library to browse instead

  Scenario: The search page is the way into Browse and Tags
    When I open the search page without a term
    Then I am offered ways into the library
    And choosing "Browse all items" opens browse
    And choosing "Browse by tag" opens browse by tag

  Rule: Before anything is typed, the search page shows the library at a glance

    Scenario: The search page without a term is an index of the library
      When I open the search page without a term or filters
      Then I see how many items I can read
      And I can start from a content type, a topic, a category or a popular tag, each with its count
      And I see the most recently verified items and the most recently updated items
      And none of it counts drafts or topics I am not allowed to see

    Scenario: A content type from the index becomes a search
      When I choose a content type from the index
      Then the search page lists items of that type, newest first
      And the sort offers "Newest" rather than "Relevance", since nothing was typed

  Rule: Matches are shown, not just listed

    Scenario: The words I searched for are highlighted
      When I search for two words
      Then both words are highlighted wherever they appear in a result's title and snippet
      And the last word is highlighted even while it is still being typed as a prefix

    Scenario: Snippets read as prose
      When a result's text matches deep inside a long body
      Then its snippet starts and ends on whole words, with an ellipsis where it was cut
      And it contains no Markdown or wiki-link syntax

  Rule: Every word counts, wherever it is found

    Scenario: A result must match every word I typed
      Given an item whose topic name contains only one of my two words
      When I search for both words
      Then that item is not a result
      And the result count and the filter counts do not include it

    Scenario: Topic, category, tag group and alias names are searchable
      Given an item whose only mention of a word is its topic name, category, tag group or alias
      When I search for that word
      Then the item is found

    Scenario: Acronyms and identifiers rank where you expect
      Given one item titled with an acronym and another that mentions it once in passing
      When I search for the acronym in capitals
      Then the item titled with it ranks first

  Rule: The query language covers who, when and how trustworthy

    Scenario: Filtering by author
      When I search with author:"Ada Lovelace"
      Then only items whose authors include Ada Lovelace are listed, regardless of letter case
      And -author: excludes that author instead

    Scenario Outline: Filtering by when an item was updated
      When I search with updated:<value>
      Then only items updated <meaning> are listed

      Examples:
        | value       | meaning                         |
        | 2026        | during 2026                     |
        | 2026-08     | during August 2026              |
        | >2026-08-20 | after 20 August 2026            |
        | 30d         | within the last 30 days         |

    Scenario Outline: Filtering by trust and lifecycle
      When I search with is:<value>
      Then only <which> items are listed

      Examples:
        | value        | which                                       |
        | verified     | human-reviewed or machine-confirmed         |
        | unverified   | never verified                              |
        | needs-review | past their review date                      |
        | draft        | draft (only drafts I am allowed to see)     |

    Scenario: An unreadable filter value is reported, not silently ignored
      When I search with updated:"last spring"
      Then the search still runs without that filter
      And I am told the value was not understood

    Scenario: Trust and status are filters on the page too
      Given the search page is showing results
      Then I can narrow them by trust tier from the filters
      And the address carries that choice with the same "is" vocabulary as the query language

    Scenario: Sorting by recently verified
      When I choose "Recently verified" as the sort
      Then the most recently verified items come first and never-verified items come last

  Rule: A search can stay within one topic

    Scenario: Searching from a topic page stays in that topic
      Given I am on a topic's landing page
      When I search from its "Search in <topic>" box
      Then the search page lists only that topic's matches
      And a chip says "In <topic>"

    Scenario: A new search keeps the topic, and removing the chip widens it
      Given the search page is scoped to a topic
      When I type a different search
      Then the results are still limited to that topic
      And removing the "In <topic>" chip searches every topic

    Scenario: An article offers a search of its topic
      When I open an article
      Then next to its topic there is a way to search within that topic

  Rule: The search page fits the room it has

    Scenario: On a wide screen the filters sit beside the results
      Given the search page is showing grouped results on a wide screen
      Then the filters are listed in a sidebar beside the results
      And the results keep a comfortable reading width
      When I choose one content type in the sidebar
      Then only results of that content type are listed
      And that option is shown as chosen

    Scenario: At medium width the filters sit above the results
      Given the search page is showing grouped results at medium width
      Then each group of filters is a row of chips above the results

    Scenario: On a phone the filters open in a dialog
      Given the search page is showing grouped results on a phone
      When I open the filters
      Then the filters appear in a dialog
      When I choose one content type
      Then the results narrow straight away and the dialog stays open
      When I dismiss the dialog
      Then I am back on the button that opened it, which counts one filter
      And the chosen filter is shown above the results, ready to remove

    Scenario: Nothing scrolls sideways on a small phone
      Given a result with a long title matches my search
      When I search on a 360-pixel-wide screen
      Then the page does not scroll sideways

  Rule: Long filter lists stay short

    Each group of filters shows its six most common options; the rest wait
    behind a "Show more" control. An option I have chosen is always shown.

    Scenario: A long group of filters shows six options and offers the rest
      Given the results carry more than six tags
      When I view the filters on a wide screen
      Then the tag filters show six options and offer to show the rest
      When I ask to see the rest
      Then every tag is offered
      And I can ask to see fewer again

    Scenario: A chosen option is never folded away
      Given I chose a tag from below the first six
      When I ask to see fewer tags
      Then the tag I chose is still shown as chosen

    Scenario: The rest of a long group is offered at every width
      Given the results carry more than six tags
      Then at medium width the row of tag chips ends in a "Show more" chip
      And on a phone the filters dialog offers the rest of the tags the same way

  Rule: Quick search remembers my recent searches

    Recent searches are kept in this browser for this account only and are
    never sent to the server. A search counts once it is submitted to the
    search page, or once I open a result from the quick search with a term typed.

    Scenario: A search I ran is offered when I next open the quick search
      Given I searched for a term from the quick search
      When I open the quick search again
      Then the box is empty
      And the term is listed under recent searches
      And it is still listed after I reload the page

    Scenario: Recent searches are newest first without repeats
      Given I searched for "alpha", then "beta", then "ALPHA"
      When I open the quick search
      Then the recent searches are "ALPHA" then "beta"

    Scenario: Choosing a recent search runs it again
      Given my recent searches are listed
      When I choose one of them
      Then its term fills the box and its results are shown

    Scenario: Typing alone is not remembered
      Given I typed a term into the quick search
      When I close it without searching or opening a result
      Then no recent search is listed

    Scenario: Opening a result is remembered
      Given I typed a term into the quick search
      When I open one of its results
      Then the term is listed under recent searches next time

    Scenario: I can remove one recent search or clear them all
      Given two recent searches are listed
      When I remove one of them
      Then only the other is listed
      When I clear recent searches
      Then no recent search is listed, even after a reload

    Scenario: Each account keeps its own recent searches
      Given someone searched while signed out on this browser
      When I open the quick search while signed in
      Then only my own recent searches are listed

    Scenario: Quick search works where the browser cannot store anything
      Given this browser refuses to store site data
      When I search from the quick search
      Then I reach the search page as usual
      And no recent search is listed

    Scenario: On a phone the quick search fills the screen
      Given I am using a phone-sized screen
      When I choose the search icon in the header
      Then the quick search fills the screen with the box ready to type in
      And I can cancel it without a keyboard
