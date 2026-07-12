Feature: Authentication and session management
  As a Knowledge E3 user
  I want a secure sign-in session
  So that only authorised users can read and change the knowledge base

  Background:
    Given the application has an administrator account

  Scenario: A valid administrator can sign in
    When the administrator signs in with valid credentials
    Then the application starts an authenticated session
    And the administrator can access the knowledge base

  Scenario: Invalid credentials are rejected
    When someone signs in with an incorrect password
    Then no authenticated session is created
    And the person is told the sign-in failed

  Scenario: The current session identifies the user
    Given I am signed in as an administrator
    When the application checks the current session
    Then my username and role are available to the app

  Scenario: Signing out ends the session
    Given I am signed in
    When I sign out
    Then protected application areas require a new sign-in

  Scenario: Administrators can create users
    Given I am signed in as an administrator
    When I create a regular user with valid account details
    Then the new user can sign in
    And the new user does not receive administrator privileges by default

  Scenario: Regular users cannot manage accounts
    Given I am signed in as a regular user
    When I try to create another user
    Then the action is refused

  Scenario: Changing a password requires the old password
    Given I am signed in
    When I try to change my password with an incorrect old password
    Then the password is not changed
    When I provide the correct old password and a valid new password
    Then the new password works for the next sign-in

  @pending
  Scenario: Repeated failed sign-ins are throttled
    Given sign-in throttling is enabled
    When the same account has too many failed sign-in attempts
    Then additional attempts are temporarily refused
    And other accounts are not affected
