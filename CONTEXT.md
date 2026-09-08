# Travel Planning

This context describes the language shared by the traveler, conversation, and itinerary planning parts of the product. It keeps conversational state separate from travel facts and versioned plans.

## Ownership And Conversation

**Owner**:
The person or anonymous identity that owns conversations and trips. An Owner's data must never be visible to another Owner.
_Avoid_: Account, User, Session

**Conversation**:
An isolated sequence of turns about travel planning, with at most one active Trip at a time. A Conversation is not the same thing as a Trip or a browser session.
_Avoid_: Session, Chat thread

**Turn**:
One user input and the product response produced from it. A repeated submission of the same Turn is still the same Turn.
_Avoid_: Request, Prompt

**Typed Command**:
An explicit itinerary change whose meaning is already known, such as moving, removing, locking, or replacing a Visit. It does not require natural-language intent interpretation.
_Avoid_: UI event, Tool call

## Travel Requirements

**Trip**:
A travel project such as "Beijing cultural trip" that owns requirements and a history of itinerary versions. A Trip is not any single generated itinerary.
_Avoid_: Journey, Plan, Itinerary

**Trip Brief**:
The normalized statement of a Trip's destination, duration, constraints, preferences, and accepted assumptions. It is the canonical interpretation of the user's current requirements.
_Avoid_: Prompt, User message, Profile

**Hard Constraint**:
A requirement that a valid itinerary must satisfy. If two Hard Constraints conflict, planning pauses for an Owner decision.
_Avoid_: Preference, Hint

**Preference**:
A quality the itinerary should optimize when possible, without making the itinerary invalid when it cannot be fully satisfied.
_Avoid_: Hard Constraint, Requirement

**Assumption**:
A visible, editable default used when a non-blocking Trip Brief field is absent.
_Avoid_: Fact, Inference

**Requirement Issue**:
A missing, ambiguous, unsupported, or conflicting part of the Trip Brief. A blocking Requirement Issue prevents planning; a non-blocking issue becomes an Assumption or Warning.
_Avoid_: Validation error, Clarification

## Itinerary

**Itinerary Version**:
An immutable snapshot of one complete proposed itinerary for a Trip. Every accepted generation or revision creates a new version.
_Avoid_: Trip, Current plan, Draft object

**Day Plan**:
The ordered Visits and travel Legs for one day of an Itinerary Version.
_Avoid_: Route, Schedule

**Place**:
A real geographic destination confirmed by an external place source. A Place exists independently of whether it is visited on a particular day.
_Avoid_: Visit, Attraction name, Coordinate

**Visit**:
A planned presence at a Place within a Day Plan, including its intended time and duration.
_Avoid_: Place, Stop

**Visit Order**:
The sequence in which Visits occur within a Day Plan. It is separate from the geographic shape used to display travel.
_Avoid_: Route

**Leg**:
The travel between two adjacent Visits, including transport mode and available distance, duration, and geometry facts.
_Avoid_: Visit, Route

**Leg Geometry**:
The provider-confirmed geographic shape of a Leg. It must not be inferred from a list of Place names.
_Avoid_: Route line, Visit Order

## Evidence And Execution

**Evidence**:
A time-stamped external source supporting a travel recommendation or factual claim. Evidence is distinct from model-written narrative.
_Avoid_: Citation text, Model knowledge

**Warning**:
A visible uncertainty or degraded fact that does not make an Itinerary Version unusable, such as an unverified opening time.
_Avoid_: Error, Assumption

**Generation Run**:
One resumable attempt to create or revise an Itinerary Version. Its lifecycle is separate from the Conversation and the Trip.
_Avoid_: Conversation, Request, Agent session

