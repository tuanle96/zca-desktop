2026-06-04 16:29 | feature-1 | Cloud device restore consent

Plan: keep Zalo credentials hosted/backend-owned and leave SaaS device tokens in the OS keychain, but remove automatic keychain reads from startup and the login gate. Add a non-secret localStorage marker for a previously linked cloud device, expose an explicit "continue linked cloud device" action, update Vietnamese copy from session restore to cloud device connection, then verify with frontend check/build, structural harness, and evidence/review artifacts.
