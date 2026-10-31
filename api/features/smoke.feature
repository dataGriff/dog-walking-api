Feature: Smoke
  The requests live in health.http and fixtures.http; the phrases used
  here are declared on them with "# @step".

  Scenario: The worker answers
    When the API is up
    Then the response status is 200
    And the response body "$.ok" is "true"

  Scenario: Records need a bearer token
    When I list clients without a token
    Then the response status is 401
    And the response body "$.error_code" is "unauthenticated"

  Scenario: The fixture walker sees the seeded records
    Given the fixtures are seeded
    When I list the seeded clients
    Then the response body "$.clients[*].name" contains "Alice Ahmed"
    When I fetch Biscuit
    Then the response body "$.breed" is "Cockapoo"
