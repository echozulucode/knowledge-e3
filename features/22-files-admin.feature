Feature: Files admin
  As an administrator of this instance
  I want to find any uploaded file, see what uses it, and upload or delete files safely
  So that the library stays tidy without breaking an item or the site

  Decisions behind this file (the admin UX review §4.9):
  - The page keeps its navigation label, Files, and its address.
  - A file counts as used when an item references it or the site shows it (logo, favicon, a pinned-topic cover); only a file used by nothing can be deleted.
  - Unused is a plain fact about a file, not an error.
  - Above 50 files the library opens as a list; an explicit choice of grid or list is kept in the address.

  Background:
    Given I am signed in as an administrator

  Rule: The library can be searched, filtered and sorted, and the view is part of the address

    Scenario: The header states the size of the library and what could be reclaimed
      Given the library holds 312 files taking 1.4 GB, 23 of them unused and taking 180 MB
      When I open Admin then Files
      Then the header says "312 files · 1.4 GB · 23 unused, 180 MB reclaimable"
      And Upload is the main action at the top of the page

    Scenario: Filters, sort and the chosen view survive a reload
      Given the library holds a used image and two unused text files named "notes"
      When I search for "notes", show only documents that are unused, sorted by name, as a list
      And I reload the page
      Then I see the two text files as rows in name order
      And the search, type, usage, sort and view are still chosen

    Scenario Outline: The default view follows the size of the library
      Given the library holds <count> files
      And I have not chosen a view
      When I open Admin then Files
      Then the files are shown as <view>

      Examples:
        | count | view       |
        | 12    | thumbnails |
        | 50    | thumbnails |
        | 51    | a list     |

    Scenario: A chosen view is kept even when the library grows
      Given the library holds 51 files
      When I choose the grid view
      And I reload the page
      Then the files are shown as thumbnails

  Rule: Each file shows where it is used, and deletion is only offered for a file nothing uses

    Scenario: A file's details name the items that use it
      Given a text file is linked from the published item "Onboarding handout"
      When I open the file's details
      Then I see its name, size, type, when it was uploaded and by whom, and its URL with a Copy button
      And "Used by" lists "Onboarding handout" as a link to that item
      And Delete is unavailable with the reason "In use by 1 item" shown as text

    Scenario: Items in a private topic, drafts and trashed items are all named
      Given a file is used by a draft, by an item in a private topic, and by an item in the trash
      When I open the file's details
      Then all three items are listed, marked Draft, Private topic and In trash
      And the item in the trash is not a link

    Scenario: A file the site shows cannot be deleted
      Given an image is the cover of a pinned topic and no item uses it
      When I open Admin then Files
      Then the image is marked "Used by the site"
      And it is not counted as unused or reclaimable
      And Delete is unavailable with the reason shown as text

    Scenario: An unused file is deleted after confirmation
      Given an unused text file "scratch.txt"
      When I choose Delete from its actions menu
      Then I am asked to confirm, and told this cannot be undone
      When I confirm
      Then a notice says "Deleted scratch.txt."
      And the file is no longer in the library

    Scenario: Unused files are shown neutrally
      Given an unused text file
      When I open Admin then Files
      Then the file is marked "Unused" in a neutral style, not as an error

    Scenario: Only administrators can see where files are used
      Given a file is used by an item in a private topic
      When a signed-in member asks for the file's details
      Then they are refused without seeing any item title
      And a visitor who is not signed in is refused the same way

  Rule: Uploads report progress and problems for each file

    Scenario: Several files upload with their own progress, and a refused file says why
      When I open Upload and choose a text file and a Windows program
      Then each file has its own row with a progress bar while it waits or uploads
      And the text file finishes as "Uploaded"
      And the program shows "Unsupported or unrecognized file type." next to it
      And a notice says "Uploaded 1 file; 1 could not be uploaded."

    Scenario: Files can be dropped anywhere on the page
      When I drag two files over the Files page
      Then the page shows "Drop to upload"
      When I drop them
      Then the Upload dialog opens with both files uploading

    Scenario: Uploads continue after the dialog is hidden
      Given two large files are uploading
      When I hide the Upload dialog
      Then the uploads finish and a notice reports the result

  Rule: Files works on a phone

    Scenario: The list becomes cards with actions in a menu
      Given my screen is 360 pixels wide
      When I open Admin then Files as a list
      Then each file is a card with its actions in the "⋯" menu
      And nothing on the page scrolls sideways
