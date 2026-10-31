Feature: A walk from booking to completion
  Every scenario starts with an empty session, so the Given steps create
  their own client and dog; the walker is whoever the environment's token
  names.

  Background:
    Given a client named "Carys Evans" exists
    And a dog named "Bramble" exists

  Scenario: Schedule, start and complete a walk
    When I schedule a walk for 30 minutes
    Then the response status is 201
    And the response body "$.status" is "scheduled"
    And the walk.scheduled event is in the outbox
    When I start the walk
    Then the response body "$.status" is "in_progress"
    When I complete the walk
    Then the response body "$.status" is "completed"
    And the response body "$.notes" is "Two laps of the lake"

  Scenario: A completed walk stays completed
    Given I schedule a walk for 45 minutes
    And I complete the walk
    When I try to cancel the completed walk
    Then the response status is 409
    And the response body "$.error_code" is "walk_already_closed"

  Scenario: A booked dog cannot be deleted until the walk is closed
    Given I schedule a walk for 30 minutes
    When I try to delete the dog
    Then the response status is 409
    And the response body "$.error_code" is "dog_has_open_walks"
    When I cancel the walk because of "client_request"
    Then the response body "$.status" is "cancelled"
    When I delete the dog
    Then the response status is 204
    When I delete the client
    Then the response status is 204
