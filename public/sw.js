/* Lifecycle-only worker: intentionally does not intercept or cache requests. */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { payload = { body: event.data?.text() ?? "Open crew chat to see the message." }; }
  const title = typeof payload.title === "string" ? payload.title : "IAC Media Operations";
  const body = typeof payload.body === "string" ? payload.body : "You have a new crew chat mention.";
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof payload.tag === "string" ? payload.tag : "crew-chat-mention",
    renotify: true,
    vibrate: [180, 90, 180],
    data: { url: typeof payload.url === "string" ? payload.url : "/?open=chat" },
  }));
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
    const target = event.notification.data?.url;
    const destination = typeof target === "string" && target.startsWith("/") ? target : alarmId ? "/?open=time" : "/?open=chat";
    if (appWindow) {
      appWindow.postMessage({ type: alarmId ? "open-time" : "open-chat" });
      await appWindow.focus();
    } else await self.clients.openWindow(destination);
  })());
});
