# Durable project task queue

The Projects window can queue a task with the selected agent. Queued tasks remain local and durable while their prerequisites are blocked. Once every dependency has been explicitly verified, the native desktop runtime may dispatch the task.

Before starting a worker, IRIS atomically changes the entry from `queued` to `claimed`. The storage transaction also refuses a second claimed task for the same agent, including from another IRIS window. The worker starts only after that durable claim succeeds.

If IRIS stops while an entry is claimed, startup changes it to `needs-attention`. IRIS does not guess whether the worker reached a provider or tool and does not replay that task. A user must inspect the actual outcome and queue it again if appropriate. Entries can be removed while still queued; claimed work cannot be silently cancelled from the queue because dispatch may already have begun.

The project queue runs only in the native desktop application while IRIS is running. Browser preview does not execute queued tasks, and IRIS does not continue after Quit.
