import { App } from './app'

const app = new App()
app.start()
// e2e test hook — exposes teleport/join/state helpers
;(window as unknown as Record<string, unknown>).__fimp = app.testHook()
