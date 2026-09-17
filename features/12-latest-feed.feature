Feature: Latest feed and series
  As a reader keeping up with the library
  I want a chronological feed of what was published
  So that I can see what is new without searching for it

  Background:
    Given a published Blog Post with a publish date, authors, and a series
    And a draft Blog Post

  Scenario: Latest lists published items newest first
    When I open Latest
    Then the published post appears as a card with its title, authors, reading time, and publish date
    And the draft does not appear

  Scenario: A card is quiet about an unverified trust tier
    Given a published Blog Post nobody has verified
    When I open Latest
    Then its card says nothing about its trust tier
    But the post's own page still states it

  Scenario: A card links to its series
    When I open Latest
    Then the post's card carries a series chip
    And choosing it opens the series page

  Scenario: Latest offers an Atom feed
    When I open Latest
    Then an Atom feed link is offered

  Scenario: Loading more continues from where the feed left off
    Given more published items than one page of the feed holds
    When I open Latest and choose "Load more"
    Then the next page of items is appended without repeating any

  Scenario: A series page is headed by its Series item and lists its parts in reading order
    Given a published Series item
    And three published posts in that series with reading positions, created out of order
    When I open the series page
    Then the heading is the Series item's title, not the series slug
    And the Series item's description and the parts' total reading time are shown
    And the posts are numbered in reading order

  Scenario: A series without a Series item still has a readable heading
    Given a published post in a series that has no Series item
    When I open the series page
    Then the heading is the series slug written as words

  Scenario: An article in a series says where it sits and moves through the series
    Given a published Series item with three published parts
    When I open the second part
    Then it says it is part 2 of 3 in the series, linking to the series page
    And expanding the series shows every part with the current one marked
    And previous and next links name the neighbouring parts and open them

  Scenario: A series of one shows no series navigation
    Given a published post that is the only part of its series
    When I open the post
    Then no series box and no previous or next links are shown

  Scenario: An article states its trust tier in the byline
    Given a published post nobody has verified
    When I open the post
    Then its byline says "Unverified" as quiet text, with an explanation on request
