/**
 * Native macOS menu — standard roles plus Unbox-specific actions wired back
 * into the renderer via the app:menu channel.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MenuDeps {
  onNavigate: (route: string) => void
  onCancel: () => void
}

export function buildMenu(deps: MenuDeps): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Cmd+,',
          click: () => deps.onNavigate('settings')
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Archive…',
          accelerator: 'CmdOrCtrl+O',
          click: () => deps.onNavigate('open-archive')
        },
        {
          label: 'Choose Destination…',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => deps.onNavigate('pick-destination')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    },
    {
      label: 'Extraction',
      submenu: [
        {
          label: 'Cancel Extraction',
          accelerator: 'CmdOrCtrl+.',
          click: () => deps.onCancel()
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => deps.onNavigate('home') },
        { label: 'History', accelerator: 'CmdOrCtrl+2', click: () => deps.onNavigate('history') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+3', click: () => deps.onNavigate('settings') },
        { label: 'Diagnostics', accelerator: 'CmdOrCtrl+4', click: () => deps.onNavigate('diagnostics') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.defaultApp ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : [])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
