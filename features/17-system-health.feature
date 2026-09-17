Feature: System health and the readiness probe
  As an administrator responsible for this instance
  I want one page that says whether the instance is healthy right now, and a probe a load balancer can read
  So that I learn about a broken database, a full disk or an unrehearsed restore before a user does

  Background:
    Given I am signed in as an administrator

  Scenario: The page answers the question before it lists anything
    When I open Admin then Health then System
    Then a single verdict of Healthy, Degraded or At risk is shown first
    And a sentence under it names the checks responsible for that verdict
    And the checks that caused it are listed above the ones that passed

  Scenario: Every check explains itself and what to do about it
    When I open Admin then Health then System
    Then each check reports its own state, a one-line explanation, and its supporting evidence
    And every check that is not passing says what to do about it

  Scenario: An instance that has never rehearsed a restore is reported as unverified
    Given no restore drill has ever run on this instance
    When I open Admin then Health then System
    Then the restore drill is reported as a finding rather than as missing data
    And it says "Backups are unverified: the restore drill has never run."
    And it names the command that rehearses a restore
    And the overall verdict is At risk

  Scenario: Passing checks stay out of the way of the ones that need me
    Given every check passes except one
    When I open Admin then Health then System
    Then the failing check is expanded, with what to do about it
    And each passing check is one line giving its name, its state and what is true
    And a passing check's detail opens only when I ask for it

  Scenario: Every check says where in the runbook to read next
    When I open Admin then Health then System
    Then every check names its section of the operations runbook
    And I can copy that section's address with one action

  Scenario: The whole report can be copied as text without any secret in it
    Given a check's evidence quotes an error that contains a credential
    When I open Admin then Health then System
    And I copy the diagnostics
    Then the clipboard holds the verdict, when the report was generated, and every check with its state and detail
    And the credential is replaced with a redaction mark

  Scenario: The report keeps itself current while I watch it
    Given I have Admin then Health then System open
    Then the page says how long ago the report was checked, with a Refresh action
    And it checks again every 30 seconds while the tab is visible
    And it does not check while the tab is hidden
    And it checks at once when I return to the tab after the report has gone stale
    And a refresh never starts while another is still running

  Scenario: A changed verdict is announced
    Given I have Admin then Health then System open
    When a later check changes the verdict
    Then the change is announced to assistive technology
    And a refresh that leaves the verdict unchanged announces nothing

  Scenario: The page fits a phone
    Given my screen is 360 pixels wide
    When I open Admin then Health then System
    Then the verdict, the checks and Copy diagnostics are shown
    And nothing on the page scrolls sideways

  Scenario: A command a check names can be copied as it is
    Given a check tells me to run a command
    When I open Admin then Health then System
    Then the command is shown as code, without the marks around it
    And I can copy exactly that command with one action
    And if the copy fails I am told to copy it by hand

  Scenario: A late source degrades the instance without endangering it
    Given a source with a remote has not synced in several times its own cadence
    When I open Admin then Health then System
    Then the source check reports that it is behind
    And the overall verdict is Degraded

  Scenario: Secrets are reported by name and never by value
    Given an enabled source names an environment variable for its host token
    When I open Admin then Health then System
    Then the secrets check reports the name of that variable and whether it is set
    And no secret value appears anywhere on the page

  Scenario: Content health and System health stay separate pages
    When I open Admin then Health
    Then a Content and a System page are offered under one Health entry in the admin navigation
    And the Content page still lists the library's fix-it queues unchanged
    And only the page I am on is marked as current

  Scenario: The readiness probe refuses traffic when a dependency is broken
    Given the content root this instance writes to has been removed
    When a load balancer reads the readiness probe
    Then it is told the instance is not ready
    And the response carries no detail about which check failed

  Scenario: The readiness probe is narrower than the health page
    Given this instance has never rehearsed a restore
    And the system health page therefore reports At risk
    When a load balancer reads the readiness probe
    Then it is told the instance is ready
    And readiness stays narrow on purpose: a restore that was never rehearsed is a statement about the past, not an inability to serve

  Scenario: Liveness stays a question about the process alone
    Given the content root this instance writes to has been removed
    When a supervisor reads the liveness probe
    Then it is told the process is alive
    And liveness stays unconditional on purpose: restarting the process would not restore a missing content root
