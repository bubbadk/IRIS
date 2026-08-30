# IRIS Product Vision

IRIS is an **Intelligent Reasoning & Integration System**.

It should feel like an operating environment for intelligence rather than a control panel for a chatbot.

## Core experience

When IRIS opens, the user lands on a quiet, bright desktop. The workspace is mostly empty on purpose.
Objects such as Agents, Models, Memory, Skills, Projects and Systems can be opened as windows, moved,
resized and arranged. The same object can eventually expose different views such as overview, graph,
timeline or files without becoming a maze of unrelated pages.

A central command field lets a user ask for the object or task they want. The graphical interface remains
fully usable without natural language.

## Local workspace

Workspace also has a concrete local meaning: the user can mount a real folder as an IRIS object. Agents do
not inherit access merely because the folder is mounted. Listing, searching, reading, writing and execution
remain separate capabilities behind explicit permissions, and native path enforcement keeps every operation
inside the selected root. Browser-only surfaces state that local access is unavailable instead of simulating it.

## Design language

The chosen direction is the third concept on `docs/design/iris-concept-board.png`:

- warm ivory and light stone background
- gentle gradients used sparingly
- soft elevation and rounded surfaces
- confident typography
- large breathing room
- small, purposeful motion
- desktop windows instead of dashboard-card grids
- visual calm even when many processes are active

Avoid the default visual language of AI products: black panels, violet neon, glowing borders, matrix motifs,
terminal wallpaper and dense telemetry dashboards.

## Product model

IRIS itself is the platform. It is not a named assistant persona.

Users create their own agents. Each agent can have a configurable brain/provider policy, memory access,
tools, skills, permissions, autonomy level and channels.

The system should become smarter than a single model by adding a Cortex layer responsible for routing,
context selection, decomposition, verification and temporary specialist workers when needed.

## Truthful UI

If a provider, memory service, tool or integration is not configured, IRIS says so.
It must never display fabricated activity to make the interface look impressive.
