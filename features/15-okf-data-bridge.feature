Feature: The OKF data bridge in the admin console
  As an administrator who has to be able to leave
  I want to download my library as an Open Knowledge Format bundle and load one back
  So that backup, transfer between instances, and the promise that the content is mine
  are all one button rather than a CLI I have to be told about

  Background:
    Given I am signed in as an administrator

  Scenario: The data page is three tabs, and the address remembers which one is open
    When I open Admin then Data
    Then I am offered Import, Export and Audit tabs, with Import open
    And the Import tab asks me to choose one bundle, recommending an archive
    When I open the Export tab
    Then the address names the Export tab
    And reloading the page keeps the Export tab open

  Scenario: Exporting one topic downloads a conformant bundle
    Given a topic holding a published item
    When I open the Export tab
    And I choose that topic and the .json format
    And I download the bundle
    Then a file is downloaded whose name carries the topic and today's date
    And I am told in the Export card how many items were exported and that the bundle is conformant

  Scenario: Re-importing an export updates in place instead of duplicating
    Given a topic holding a published item that I have exported as a .json bundle
    When I choose that same bundle file to import
    Then I am on the Review step and told it is ready to import
    And I am told the import would update one existing item
    When I continue to the Import step
    Then I am told what the import will write before I press Import
    When I import it
    Then I am told that nothing was created and the item was updated
    And I am offered Content health and the audit log from the same card
    And the library still holds exactly one item with that title

  Scenario: An unrecognized file is refused with a reason
    When I choose a JSON file that is not an OKF bundle to import
    Then I am told the file was not recognized and what was expected
    And I stay on the Choose step
    And nothing is imported

  Scenario: Choosing a bundle checks it before anything is imported
    When I choose a bundle to import
    Then I am on the Review step
    And I am told whether it is a conformant OKF bundle
    And its findings are counted separately for conformance, policy and advisory
    And nothing has been imported yet
    And I can continue only once the check has finished

  Scenario: A bundle that is not conformant names every file at fault and cannot be imported
    When I choose a bundle in which one concept document has no type
    Then I am told how many critical issues were found across how many files
    And each issue is listed with its file, field, rule and message
    And I stay on the Review step and am told why I cannot continue
    And none of the bundle's documents are imported, including the valid ones

  Scenario: Policy findings are reported but do not block the import
    When I choose a conformant bundle whose document has no description or category
    Then I am told the policy errors will not block the import
    And the policy findings are listed with their file, field and rule
    And I am told the import would create one item
    When I continue and import it
    Then the document is imported
    And I am told its findings are listed in Content health
    And Content health is offered as a link from the Import card

  Scenario: An import's outcome is shown in the Import card, in view
    When I import a bundle
    Then how many items were created and updated is shown inside the Import card
    And the outcome is scrolled into view and focused
    And the same bundle cannot be imported a second time

  Scenario: Choosing a different bundle discards the previous check
    Given I have chosen a bundle that is not conformant
    When I choose a different bundle
    And I choose a conformant bundle instead
    Then only the new bundle's report is shown
    And I am allowed to continue

  Scenario: An import the server refuses shows the refusal report, not just a message
    Given a bundle that was checked as importable
    But the server refuses the import because the bundle is not conformant
    When I import it
    Then I am told nothing was imported
    And the refusal lists each critical issue with its file and rule
    And I am not allowed to import again until I choose a bundle

  Scenario: A long report shows its first issues and can be expanded or copied
    Given a bundle with more than fifty findings in one tier
    When I choose it to import
    Then the first fifty findings of that tier are listed
    And I can ask to see all of them
    And I can copy the whole report as plain text, one issue per line
    And if the clipboard is unavailable I am told the copy failed

  Scenario: A full .tar.gz archive is checked the same way before it is imported
    Given a topic holding a published item that I have downloaded as a .tar.gz bundle
    When I choose that archive to import
    Then I am told it is ready to import and would update one existing item
    When I continue and import it
    Then I am told that nothing was created and the item was updated

  Scenario: The library audit lives on the Audit tab, with its own topic
    Given a topic holding a published item
    When I open the Audit tab
    And I choose that topic
    Then the address names the Audit tab and the topic
    And I am told how many concepts were audited and whether they are conformant
    And the roll-up counts them by trust tier, by freshness and by provenance
    And conformance, policy and advisory findings are each grouped by rule with a count

  Scenario: The library audit lists every finding
    Given a library with more than a hundred advisory findings under one rule
    When I open the Audit tab
    And I open that rule
    Then every file it names can be reached, a page at a time

  Scenario: The import stepper fits a phone
    Given my screen is 360 pixels wide
    When I choose a bundle with long file names that is not conformant
    Then the page does not scroll sideways
