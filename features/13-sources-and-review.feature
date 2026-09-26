Feature: Sources, conflicts, and the review queue
  As an administrator running this instance against real repositories
  I want one place that shows every source, its sync policy, and what is blocking it
  So that I can keep content flowing without dropping to a shell

  Background:
    Given I am signed in as an administrator

  Scenario: Sources lists every registered entry with its policy and live state
    Given a source registered with a local working tree and no remote
    When I open Admin then Sources
    Then the source is listed with its sync policy, role, and where it points
    And its live state is shown as a chip with a text label
    And it reports that it has never synced

  Scenario: A disabled source says so in the list
    Given a source that is registered but disabled
    When I open Admin then Sources
    Then its entry is marked disabled

  Scenario: Sources that need attention are named above the list
    Given one source with open merge conflicts and one that is merging cleanly
    When I open Admin then Sources
    Then I am told that one source needs attention, naming it and its conflict count
    And the source that is merging cleanly is not named
    When I choose the named source
    Then its details open on its conflicts

  Scenario Outline: A source needs attention when something blocks it
    Given an enabled source that <problem>
    When I open Admin then Sources
    Then it is named among the sources that need attention

    Examples:
      | problem                                                                  |
      | has open merge conflicts                                                 |
      | uses the review policy and names a host token not set on this server     |
      | uses the review policy and names a webhook secret not set on this server |
      | failed its last sync cycle                                               |

  Scenario: A direct source is not blocked by a token it never uses
    Given a direct source with no remote that names a host token not set on this server
    When I open Admin then Sources
    Then it is not named among the sources that need attention

  Scenario: A source that cannot reach its private repository is named
    Given a direct source on a private remote that names a host token not set on this server
    When I open Admin then Sources
    Then it is named among the sources that need attention
    And the variable's name is shown, never its value

  Scenario: The list can be narrowed, and the narrowing can be shared
    Given two registered sources, one of which needs attention
    When I search Sources for the other one's id
    Then only that source is listed
    When I reload the page
    Then the search is still applied
    When I clear the filters and show only sources that need attention
    Then only the source that needs attention is listed

  Scenario: A link can open a source's details on a chosen section
    Given a source registered with a local working tree and no remote
    When I follow a link to that source's conflicts
    Then its details open with its conflicts showing
    And no change requests section is offered for a direct source
    When I switch to what it selects
    Then the address I am on names that section

  Scenario: A link to a source that is not registered says so
    When I follow a link to the details of a source that is not registered
    Then I am told there is no such source

  Scenario: The list stays current while a sync runs
    Given a source whose sync cycle is running
    When I keep Admin then Sources open
    Then its state is refreshed every few seconds until the cycle ends
    And it is refreshed about once a minute after that
    And nothing is refreshed while the browser tab is hidden

  Scenario: The sync policies explain themselves
    When I open the form to register a source
    Then each of direct, review, and read-only explains what it does to local commits, pushes, inbound changes, and who publishes
    And each names the kind of team it fits

  Scenario: A credential can be named whatever the policy is
    Given I am registering a source
    When I choose the direct policy
    Then I can name the environment variable holding this source's token
    And it says the token is what git uses to reach a private repository

  Scenario: A change-request host is required only by the review policy
    Given I am registering a source
    When I choose the direct policy
    Then I can save without choosing a change-request host
    When I choose the review policy
    Then I cannot save until a host is chosen

  Scenario: A direct source keeps the credential it was given
    Given I am registering a source with the direct policy and a private remote
    When I name the environment variable holding its token and save it
    Then I am told the source was saved
    When I open it again
    Then it still names that variable

  Scenario: A source is registered from the form
    Given I am registering a source
    When I give it an id, a working tree, the direct policy, and no remote
    And I save it
    Then I am told the source was saved
    And its details open
    And it appears in the list of registered sources
    And no credentials were asked for anywhere in the form

  Scenario: Leaving the form with unsaved changes asks first
    Given I am editing a source
    And I have changed its branch
    When I close the form
    Then I am asked whether to discard my changes
    When I choose to keep editing
    Then my change is still in the form
    When I close the form again and discard my changes
    Then the form is closed and nothing was saved

  Scenario: A save the server refuses keeps what I typed
    Given another source already uses the working tree "topics/handbook"
    And I am registering a source
    When I give it the working tree "topics/handbook" and save it
    Then the form stays open with everything I entered
    And the reason is shown beside the working tree field
    And the working tree field is listed among the fields that need attention
    And the form says it was not saved
    When I change the working tree
    Then the reason beside it is cleared

  Scenario: A connection test speaks only for the URL it tested
    Given I am registering a source
    And I have tested the connection to a remote URL
    When I change the remote URL
    Then the earlier connection result is no longer shown

  Scenario: A connection test names the variable this server is missing
    Given I am registering a source with a private remote
    And I have named an environment variable nobody has set on this server
    When I test the connection
    Then I am told that variable is not set on this server
    And I am told where to set it
    And the value of no variable is shown

  Scenario: Removing a source asks me to type its id
    Given a source registered with a local working tree and no remote
    When I choose to remove it from its actions in the list
    Then I am told that indexing stops and that files on disk and the remote repository are untouched
    And I cannot confirm until I have typed the source's id exactly
    When I cancel
    Then the source is still registered
    When I choose to remove it again, type its id, and confirm
    Then it is no longer listed

  Scenario: A source chooses which files it indexes
    Given a source registered with no include or exclude globs
    When I edit it to include "docs/**/*.md" and "handbook/*.md", exclude "docs/archive/**", and give imported files the How-To type
    And I save it
    Then its details list those globs and the How-To default type
    And editing it again summarises those globs before I expand them, and shows them one per line
    And its row is marked Selective, with every glob in the marker's description

  Scenario: Which files a source indexes is out of the way until it is needed
    When I open the form to register a source
    Then the choice of which files it indexes is collapsed and says it uses the OKF layout
    And the branch prefix, sync interval, and default status are collapsed under Advanced

  Scenario: A glob that leaves the repository is refused before it is saved
    Given I am editing a source
    When I add an include glob that is an absolute path or climbs out with ".."
    And I try to save it
    Then I am told why beside the globs
    And nothing is saved

  Scenario: Clearing the globs restores the default layout
    Given a source that includes "docs/**/*.md"
    When I clear both glob lists and save
    Then its row is no longer marked Selective
    And its details say it indexes the OKF layout

  Scenario: A source's details show what it selects, what it indexed, and where its tree is
    Given a source that selects files by glob and has indexed items from a working tree with commits
    When I open its details
    Then its overview shows its live state and what that state means
    And how many items are indexed from it
    And the commit its working tree is on, with when it was committed
    And whether the host token it names is set on this server
    And what it selects lists its include globs, exclude globs, default type, and default status
    And its conflict queue is one section away

  Scenario: A source with no clone yet says so instead of showing a commit
    Given a source whose working tree has not been cloned
    When I open its details
    Then it reports no indexed items
    And it says there is no commit to report

  Scenario: Sync now and Push now act on one source
    Given a source registered with a remote
    When I open Admin then Sources
    Then that source offers Sync now and Push now
    And a source with no remote offers neither

  Scenario: A read-only source is never pushed
    Given a source registered with the read-only policy
    When I open Admin then Sources
    Then Push now is not available for it

  Scenario: A source with a clean merge shows an empty conflict queue
    Given a source with no parked merge conflicts
    When I open its details
    Then I am told that the source is merging cleanly

  Scenario: A conflict offers both sides and three ways out
    Given a source with a parked merge conflict on an item
    When I open its conflicts
    Then my version and their version are shown side by side, with their differences marked
    And I can keep mine, keep theirs, or edit and resolve

  Scenario: Keeping one side asks first and names what is discarded
    Given a source with a parked merge conflict on "concepts/runbook.md"
    When I choose to keep their version
    Then I am asked to confirm keeping theirs for "concepts/runbook.md"
    And I am told that my version is discarded
    When I cancel
    Then nothing is resolved and the conflict is still open

  Scenario: Resolving a conflict moves it into the collapsed history
    Given a source with a parked merge conflict
    When I keep their version and confirm
    Then the conflict leaves the open list
    And it appears in the collapsed resolved history, recorded as kept theirs

  Scenario: The resolved history comes from the server, not from this session
    Given a source whose conflict was resolved before this visit
    When I open its details
    Then the collapsed resolved history lists that file, how it was resolved, and by whom
    When I reload the page and open its details again
    Then the resolved history still lists it

  Scenario: Editing and resolving records a hand-merged resolution
    Given a source with a parked merge conflict
    When I choose to edit and resolve and save merged content
    Then the conflict is recorded as merged by hand

  Scenario: A review-mode source lists its open change requests
    Given a source with the review policy and an item whose change request is open
    When I open its change requests
    Then the item is listed with a link to its change request
    And I can refresh it or merge it

  Scenario: The review queue groups every item in review by its source
    Given items in review in two different review-mode sources
    When I open the review queue
    Then the items are grouped under the source that opened their change request
    And each group names where that source points

  Scenario: The review entry appears for the people it concerns
    Given I am signed in as an administrator
    Then a Review entry sits between Latest and Browse in the sidebar
    And every other sidebar destination is still offered

  Scenario: An item in review says so on its read page
    Given a published item whose change request is open
    When I open its read page
    Then it carries an In review badge linking to its change request

  Scenario: Compose says so too
    Given an item whose change request is open
    When I open it in Compose
    Then it carries an In review badge linking to its change request

  Scenario: Content health lists files that arrived through sync with lint errors
    Given an item that arrived through sync with error-severity diagnostics
    When I open Content health
    Then it appears in the "Arrived with lint errors (sync or import)" queue

  Scenario: Content health lists concepts imported from an OKF bundle below local standards
    Given a concept imported from an OKF bundle with no primary category
    When I open Content health
    Then it appears in the "Arrived with lint errors (sync or import)" queue

  Scenario: A lint queue row names the file, its source, and every broken key
    Given an item that arrived through sync with error-severity diagnostics
    When I open Content health
    Then its row in the lint queue names the source it came from and the file it came from
    And each diagnostic is listed with its rule code, its message, and the frontmatter key it points at
    And the row still opens the item in Compose
    And the row points at the runbook section for an import that was flagged

  Scenario: A lint queue row from an OKF import says it came through the import
    Given a concept imported from an OKF bundle with no primary category
    When I open Content health
    Then its row in the lint queue says it arrived through the OKF import
    And it names the file and the missing category key

  Scenario: A file with many lint findings shows the first of them and how many more there are
    Given an item whose inbound file broke more rules than a row lists
    When I open Content health
    Then its row lists the error-severity findings first
    And it says how many more findings were left off

  Scenario: Content health summarises what sync is blocked on
    Given two open merge conflicts across one source
    When I open Content health
    Then the sync summary reports the open conflicts and names the source they block
    And it links to Sources to resolve them

  Scenario: Content health says so when nothing is blocked
    Given no open merge conflicts
    When I open Content health
    Then the sync summary reports that every source is merging cleanly

  Scenario: Content health leads with what needs attention
    Given an item arrived through sync with error-severity diagnostics
    And two open merge conflicts across one source
    When I open Content health
    Then the first thing on the page says how many things need attention
    And the open merge conflicts are listed first, linked to that source's conflicts
    And the lint queue is listed, linked to its table on this page

  Scenario: Content health says when nothing needs attention
    Given no open merge conflicts, no unconfirmed git mirror writes, no recent refusals
    And no item in the lint or declined-removal queues
    When I open Content health
    Then it says nothing needs attention

  Scenario: Content health shows findings apart from the library counts
    When I open Content health
    Then I am shown the conformance, policy, and advisory findings, each with its status in words
    And each finding links to the library audit on Data, for the topic I am viewing
    And how many items, published items, and drafts there are is shown separately

  Scenario: Clear fix-it queues fold into one line
    Given only the Untyped queue holds an item
    When I open Content health
    Then the Untyped queue is listed with its count and its table is open
    And the other seven queues are summed up as clear in one line

  Scenario: A long fix-it queue is paged
    Given the Stale queue holds 120 items
    When I open the Stale queue on Content health
    Then the first 50 are listed with their type and source
    When I go to the next page
    Then items 51 to 100 are listed
    And the address remembers the queue and the page

  Scenario: Instance-wide sections say they are not filtered by topic
    When I open Content health for one topic
    Then Sync, Git mirror and Recent refusals are grouped as instance-wide and marked not filtered by topic
    And each is a single line while it is healthy

  Scenario: Content health says how fresh it is
    When I open Content health
    Then it says when the report was checked
    And I can refresh it

  Scenario: A fix-it queue row opens the item in Compose
    Given a draft with no content type
    When I open the Untyped queue on Content health
    Then the Untyped queue offers that item
    And the item's name opens it in Compose

  Scenario: A removal declined upstream links to the change request, not to the deleted item
    Given a removal was proposed through a change request that the reviewer declined
    And the item could not be restored automatically
    When I open Content health
    Then the declined-removal queue names the item as text
    And it links to that change request, opening it in a new tab
    And it offers no link to the deleted item's editor

  Scenario: The git mirror says so when every indexed change has reached git
    Given no indexed change is waiting to be committed
    When I open Content health
    Then the git mirror section reports that every indexed change has reached git

  Scenario: An indexed change that has not reached git is an alert, not a lost item
    Given an indexed change whose commit has not been confirmed for longer than the threshold
    When I open Content health
    Then the git mirror section raises an alert naming how many changes are pending
    And it lists the item, its file, and how long it has been waiting
    And it explains that the content is indexed and readable but not yet durable in git
    And it explains that restarting the server replays the pending rows

  Scenario: A source says whether the token it names is set on this server
    Given a source that names an environment variable holding its host token
    When I open its details
    Then its host names that variable and marks it as set
    And the value of the variable is never shown

  Scenario: A source whose token is missing says so, and where the runbook answers it
    Given a source that names an environment variable nobody has set
    When I open its details
    Then its host marks that variable as not set on this server
    And it points at the runbook section for a change request that will not open

  Scenario: Editing a source shows whether a named secret is set, only for the name the server checked
    Given a review-mode source whose host token variable is set on this server
    When I edit it
    Then the host token field says the variable is set on this server
    When I change the variable's name
    Then the field no longer says whether it is set

  Scenario: An alert on Content health names the runbook section that answers it
    Given an indexed change whose commit has not been confirmed for longer than the threshold
    And two open merge conflicts across one source
    And an item that arrived through sync with error-severity diagnostics
    When I open Content health
    Then the git mirror alert names the runbook section for content that is not reaching git
    And the sync summary names the runbook section for a source in conflict
    And the lint queue names the runbook section for an import that was flagged
    And a queue the runbook does not cover names no section at all

  Scenario: The git mirror evidence can be captured before it is fixed
    Given an indexed change whose commit has not been confirmed for longer than the threshold
    When I open Content health
    And I copy the git mirror diagnostics
    Then the copied text carries each pending row's item, outbox entry, kind, source, file, age, and mirror state
    And it is text I can paste into an issue

  Scenario: A publish the content rules refused is visible to an administrator
    Given an author tried to publish an item that is missing its description
    And the publish was refused
    When I open Content health
    Then the recent refusals list the attempt with who made it, through which door, the item, and the rules it broke
    And the item's content is not shown
    And it links to the audit log filtered to refusals

  Scenario: A file that arrives through sync is never counted as a refusal
    Given an item that arrived through sync with error-severity diagnostics
    When I open Content health
    Then it appears in the "Arrived with lint errors (sync or import)" queue
    And the recent refusals do not list it
