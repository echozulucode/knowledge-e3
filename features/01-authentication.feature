Feature: Authentication and session management
  As a Knowledge E3 visitor or contributor
  I want public knowledge to be readable without signing in and protected actions to require a session
  So that knowledge is open by default without exposing private or unpublished work

  Background:
    Given the application has an administrator account

  Rule: Authentication cannot be turned off

    Scenario: The application refuses to start when its configuration disables authentication
      Given the configuration file sets the authentication mode to disabled
      When the application starts
      Then it refuses to start
      And it explains that authentication cannot be disabled and how to create an administrator account

    Scenario: The application refuses to start when the environment disables authentication
      Given the environment sets the authentication mode to disabled
      When the application starts
      Then it refuses to start
      And it explains that authentication cannot be disabled and how to create an administrator account

    Scenario: Sessions are required when no authentication mode is configured
      Given no authentication mode is configured
      When the application starts
      Then protected application areas require signing in
      And no request acts as an administrator without signing in

  Rule: Public knowledge is available without a session

    Scenario: A visitor reads published knowledge in a public Space
      Given a published knowledge item belongs to a public Space
      When a visitor browses the knowledge base without signing in
      Then the published knowledge item is available

    Scenario: A visitor cannot discover knowledge in a private Space
      Given a published knowledge item belongs to a private Space
      When a visitor browses the knowledge base without signing in
      Then the private knowledge item is not available

    Scenario: A visitor cannot discover a draft in a public Space
      Given a draft knowledge item belongs to a public Space
      When a visitor browses the knowledge base without signing in
      Then the draft knowledge item is not available

    Scenario: A visitor on the sign-in page can go back to what they can read
      Given the library is publicly readable
      And I am not signed in
      When I open the sign-in page
      Then I am offered "Back to home" and "Continue without signing in"
      And either one returns me to the front page without editing the address

    Scenario: A login-required library offers no way around sign-in
      Given the library requires sign-in to read
      When I open the sign-in page as a visitor
      Then no "Back to home" or "Continue without signing in" link is shown

  Rule: Sessions protect authoring and administration

    Scenario: A valid administrator can sign in
      When the administrator signs in with valid credentials
      Then the application starts an authenticated session
      And the administrator can access protected application areas

    Scenario: Invalid credentials are rejected
      When a person signs in with an incorrect password
      Then no authenticated session is created
      And the person is told the sign-in failed

    Scenario: The current session identifies the administrator
      Given the administrator is signed in
      When the application checks the current session
      Then the administrator's username and role are available

    Scenario: Signing out ends the session
      Given a contributor is signed in
      When the contributor signs out
      Then protected application areas require a new sign-in
      And public knowledge remains available

    Scenario: Administrators can create users
      Given the administrator is signed in
      When the administrator creates a regular user with valid account details
      Then the new user can sign in
      And the new user does not receive administrator privileges by default

    Scenario: Regular users cannot manage accounts
      Given a regular user is signed in
      When the regular user tries to create another user
      Then the action is refused

    Scenario: An incorrect old password cannot authorize a password change
      Given a contributor is signed in
      When the contributor tries to change the password with an incorrect old password
      Then the password is not changed

    Scenario: A contributor changes the password with the old password
      Given a contributor is signed in
      When the contributor provides the correct old password and a valid new password
      Then the new password works for the next sign-in

    @pending
    Scenario: Repeated failed sign-ins are throttled
      Given sign-in throttling is enabled
      When the same account has too many failed sign-in attempts
      Then additional attempts are temporarily refused
      And other accounts are not affected

  Rule: The admin console describes the sign-in methods this instance has

    Scenario: Authentication lists what is actually configurable
      Given I am signed in as an administrator
      When I open Admin then Authentication
      Then the sign-in methods are a local username and password, and personal access tokens
      And it states plainly that there is no OIDC, SAML, or LDAP support
      And no identity provider or directory integration is described as available or promised

  Rule: Privileged account and access changes are confirmed before they take effect

    Scenario: The Users list is read-only
      Given I am signed in as an administrator
      When I open Admin then Users
      Then each account shows its role and status without a control that changes them
      And opening an account shows its details in a panel

    Scenario: Promoting a user to administrator is confirmed first
      Given I am signed in as an administrator
      And a regular user named "bob" exists
      When I open bob from the Users list, choose Admin, and save
      Then I am asked "Make bob an admin?" with what an administrator can manage
      And bob is still a regular user until I confirm

    Scenario: Cancelling a role change keeps the saved role
      Given I am signed in as an administrator
      And a regular user named "bob" exists
      When I open bob, choose Admin, save, and then cancel the confirmation
      Then bob is still a regular user

    Scenario: The panel states the last-admin rule before I try
      Given I am signed in as an administrator
      And an administrator named "carol" is the only active administrator
      When I open carol from the Users list
      Then I am told carol's role cannot be changed because carol is the only active admin

    Scenario: The panel states that I cannot change my own role or disable myself
      Given I am signed in as an administrator
      When I open my own account from the Users list
      Then I am told that I cannot remove my own admin role or disable my own account

    Scenario: Disabling an account lists its consequences first
      Given I am signed in as an administrator
      And an active user named "bob" exists
      When I disable bob from bob's panel or from bob's actions in the Users list
      Then I am told that bob will be blocked from signing in, signed out everywhere, and that bob's API tokens stop working
      And nothing changes until I confirm

    Scenario: Re-enabling an account needs no confirmation
      Given I am signed in as an administrator
      And bob's account is disabled
      When I enable bob
      Then bob can sign in again

    Scenario: A password reset reveals the temporary password once, in the dialog
      Given I am signed in as an administrator
      And a user named "bob" exists
      When I reset bob's password and confirm that bob will be signed out everywhere
      Then the temporary password is shown once in the same dialog, with Copy and Done
      And it is gone from the page once I choose Done

    Scenario: The panel shows an account's recent activity
      Given I am signed in as an administrator
      And bob has recently made changes
      When I open bob from the Users list
      Then bob's most recent audited actions are listed
      And I can follow a link to all of bob's activity in the audit log
      And I can follow a link to every change made to bob's account

    Scenario: Search and filters are kept in the address
      Given I am signed in as an administrator
      When I search the Users list for "bob" and show only active administrators
      Then the address of the page records the search and both filters
      And opening that address shows the same filtered list

    Scenario: A large set of accounts is paged
      Given I am signed in as an administrator
      And more than 50 accounts exist
      When I open Admin then Users
      Then the list shows the first 50 accounts and says "1–50 of" the total
      And I can move to the next page of accounts

    Scenario: Creating a user checks the password against the policy as I type
      Given I am signed in as an administrator
      When I start creating a user
      Then each rule of the password policy is listed
      And each rule is marked as met or not met as I type the password

    Scenario: A generated password is revealed once after the user is created
      Given I am signed in as an administrator
      When I create a user with a generated password
      Then the generated password satisfies the password policy
      And after the user is created the password is shown once, with Copy and Done

    Scenario Outline: A duplicate account is refused at the field that clashes
      Given I am signed in as an administrator
      And an account already uses the <field> "<value>"
      When I try to create a user with the <field> "<value>"
      Then the user is not created
      And the <field> is marked as already in use

      Examples:
        | field    | value           |
        | username | bob             |
        | email    | bob@example.com |

    Scenario: The Users list stays usable on a phone
      Given I am signed in as an administrator on a phone-width screen
      When I open Admin then Users
      Then accounts are shown as cards
      And an account's panel fills the screen with Reset password and Disable reachable

    Scenario: Making content public requires typed confirmation
      Given I am signed in as an administrator
      And reading content requires signing in
      When I choose Public for content visibility and choose "Change to Public…"
      Then I am told that anyone on the internet could read every published item, that drafts and private topics stay hidden, and that editing still requires signing in
      And I must type "public" before the change can be confirmed
      And content visibility is unchanged if I cancel

    Scenario: Requiring sign-in again is a plain confirmation
      Given I am signed in as an administrator
      And content is public
      When I choose Login required and confirm
      Then visitors must sign in to read content

  Rule: Authentication settings say where each value came from and are saved one section at a time

    Scenario Outline: Each setting shows its provenance
      Given I am signed in as an administrator
      And the <setting> <origin>
      When I open Admin then Authentication
      Then the <setting> section says "<provenance>"

      Examples:
        | setting            | origin                                                        | provenance                                  |
        | password policy    | has never been changed                                        | Default                                     |
        | password policy    | was last saved by administrator "eric" on September 2, 2026   | Set in admin by eric · Sep 2, 2026          |
        | sign-in throttling | is set by the LOGIN_THROTTLE_PER_IP environment variable      | From environment (LOGIN_THROTTLE_PER_IP)    |
        | sign-in throttling | is set in the configuration file                              | From knowledge-e3.config                    |

    Scenario: A choice that has not been saved can be discarded
      Given I am signed in as an administrator
      When I change the minimum password length without saving
      Then only the password policy section offers Discard and Save
      And choosing Discard restores the saved minimum length

    Scenario: The minimum password length is checked when I leave the field, not while I type
      Given I am signed in as an administrator
      When I clear the minimum password length
      Then the field stays empty rather than changing to 1
      And no error is shown until I leave the field or save
      And a length outside 1 to 128 is refused with the error shown under the field

    Scenario: Leaving the page with unsaved settings asks first
      Given I am signed in as an administrator
      And I have changed a setting without saving it
      When I go to another admin page
      Then I am asked whether to discard my unsaved changes

    Scenario: Settings fixed at deploy time cannot be changed in admin
      Given I am signed in as an administrator
      When I open Admin then Authentication
      Then sign-in throttling is shown without Discard or Save
      And it explains that it is set in the configuration file or environment

  Rule: API tokens never show any part of the secret and never overstate what works

    Scenario: Token lists show no part of a token
      Given a user has a personal access token
      When the user views their tokens in Profile, or an administrator views all tokens
      Then no token value or prefix is shown or returned

    Scenario: A token whose owner is disabled is not shown as active
      Given a user has an unexpired, unrevoked personal access token
      And an administrator disables that user's account
      When an administrator views all tokens
      Then the token's status is "Owner disabled"
      And the token is listed when filtering by "Owner disabled" but not by "Active"

  Rule: Administrators manage every API token from its own page

    Scenario: API tokens have their own page under Authentication
      Given I am signed in as an administrator
      When I open Admin then Authentication then API tokens
      Then every user's tokens are listed with name, owner, scope, created, expires, last used and status
      And the admin navigation marks API tokens as the current page
      And the Authentication settings page no longer lists tokens

    Scenario: Token filters are kept in the address
      Given I am signed in as an administrator
      When I filter API tokens by the owner "bob", the state "Revoked", the scope "Write" and a name containing "ci"
      Then the address of the page records every filter
      And opening that address shows the same filtered list

    Scenario: A large set of tokens is paged
      Given I am signed in as an administrator
      And more than 50 tokens exist
      When I open API tokens
      Then the list shows the first 50 tokens and says "1–50 of" the total
      And I can move to the next page of tokens

    Scenario: Revoking a token is confirmed first
      Given I am signed in as an administrator
      And bob has an active token named "CI"
      When I choose Revoke for bob's "CI" token
      Then I am told the token stops working immediately and anything using it fails
      And the token still works until I confirm

    Scenario Outline: A token that cannot sign in cannot be revoked again
      Given I am signed in as an administrator
      And a token is <state>
      When I open that token's actions
      Then Revoke is unavailable and says "<reason>"

      Examples:
        | state   | reason                                  |
        | revoked | Already revoked.                        |
        | expired | Expired, so it already cannot sign in.  |

    Scenario: Revoking a token records which token and whose it was
      Given I am signed in as an administrator
      When I revoke bob's token named "CI"
      Then the audit log records the token's name and bob's username
      And no part of the token is recorded

    Scenario: Resetting a password records whose password it was
      Given I am signed in as an administrator
      When I reset bob's password
      Then the audit log records bob's username
      And the temporary password is not recorded

    Scenario: Revoking one of my own tokens in Profile is confirmed first
      Given I am signed in
      And I have an active personal access token
      When I choose Revoke for that token in Profile
      Then I am told the token stops working immediately
      And the token still works if I cancel

    Scenario: The API tokens list stays usable on a phone
      Given I am signed in as an administrator on a phone-width screen
      When I open API tokens
      Then tokens are shown as cards with their actions reachable
