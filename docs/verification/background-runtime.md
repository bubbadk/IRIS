# Linux background queue runtime

The System panel can install `iris-background.service` as a per-user systemd service. The service launches the installed IRIS executable with `--background-service`, hides its main window, and runs the same frontend runtimes that dispatch schedule and project queues.

IRIS keeps a single native schedule-owner lock. When an interactive process currently owns it, the service exits and systemd retries after five seconds. Once the interactive process exits, the service acquires the lock before its frontend starts queue dispatch. This prevents two processes from sending the same queued job.

The installer writes the unit only in the user’s systemd directory, imports the active graphical-session variables into that user manager, reloads units, and enables and starts the unit. Removing it disables, stops and deletes that unit. The feature requires Linux, systemd and a logged-in graphical session; it is unavailable in browser preview and is not yet implemented on macOS or Windows.
