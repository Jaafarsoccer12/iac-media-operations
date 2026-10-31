/* Lifecycle-only worker: intentionally does not intercept or cache requests. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  const alarmId = event.notification.data?.alarmId;
  const completeAlarm = event.action === "complete" && typeof alarmId === "string";
  event.notification.close();
  event.waitUntil((async () => {
    if (completeAlarm) {
      const response = await fetch("/api/operations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete_time_alarm", payload: { alarmId } }),
      }).catch(() => null);
      if (response?.ok) {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) client.postMessage({ type: "alarm-completed", alarmId });
      }
    }

    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appWindow = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (appWindow) await appWindow.focus();
    else await self.clients.openWindow("/");
  })());
});
