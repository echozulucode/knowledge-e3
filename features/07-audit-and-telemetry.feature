Feature: Audit log, telemetry, and reliability primitives
  As the maintainer of a small Knowledge E3 deployment
  I want important actions to be observable and recoverable
  So that I can diagnose problems and trust write history

  Background:
    Given I am signed in as an administrator

  Scenario: Item writes are audit logged
    When an item is created, updated, renamed, or deleted
    Then the audit log records the action
    And the entry identifies the actor and affected item

  Scenario: Audit entries are append-only
    Given audit entries already exist
    When normal application traffic continues
    Then previous audit entries are not changed or removed

  Scenario: Item views are counted
    When I open an item in the browser
    Then an item-view event is recorded for that item
    And the event can be associated with the current user when signed in

  Scenario: Bug reports can include context
    When a user submits a bug report with context
    Then the report is stored for triage
    And authenticated reports are associated with the reporter

  Scenario: Production logs are structured
    Given the server runs in production mode
    When requests are handled
    Then log lines are machine-readable
    And related log entries share a request correlation identifier

  Scenario: Development logging remains readable
    Given the server runs in local development mode
    When requests are handled
    Then logs are easy for a developer to read
    And request correlation remains visible

  Scenario: Health checks do not flood request logs
    When infrastructure probes health endpoints repeatedly
    Then those checks do not dominate the request log

  Scenario: Error reporting is inert without credentials
    Given external error-reporting credentials are not configured
    When the application starts
    Then no external error-reporting client is initialized

  @pending
  Scenario: Configured error reporting captures unhandled exceptions
    Given external error reporting is configured
    When an endpoint fails unexpectedly
    Then the exception is reported with useful context
    And private details are not exposed to the caller
