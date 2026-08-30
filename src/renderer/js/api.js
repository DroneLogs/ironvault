/* Thin wrapper over the preload bridge. Every call returns a promise and
   throws a plain Error the UI can show. */
window.IV = window.IV || {};

(function (IV) {
  'use strict';

  const bridge = window.propolis;

  function call(method, args) {
    return bridge.call(method, args);
  }

  IV.api = {
    call,

    appInfo: () => call('app.info'),
    relaunch: () => call('app.relaunch'),
    themes: () => call('app.themes'),
    getPrefs: () => call('prefs.get'),
    setPrefs: (patch) => call('prefs.set', patch),
    titleBarColors: (colors) => call('ui.titleBarColors', colors),

    listDatabases: () => call('db.list'),
    forgetDatabase: (filePath) => call('db.forget', { filePath }),
    chooseOpen: () => call('db.chooseOpen'),
    chooseNew: (name) => call('db.chooseNew', { name }),
    chooseKeyFile: () => call('db.chooseKeyFile'),
    createDatabase: (opts) => call('db.create', opts),
    openDatabase: (opts) => call('db.open', opts),
    quickUnlock: (filePath) => call('db.quickUnlock', { filePath }),
    setQuickUnlock: (opts) => call('db.setQuickUnlock', opts),
    lock: () => call('db.lock'),
    info: () => call('db.info'),
    save: () => call('db.save'),
    saveAs: () => call('db.saveAs'),
    changeCredentials: (opts) => call('db.changeCredentials', opts),
    revealInFolder: (filePath) => call('db.revealInFolder', { filePath }),

    tree: () => call('tree.get'),
    listEntries: (opts) => call('entries.list', opts),
    search: (query, includeRecycleBin) => call('entries.search', { query, includeRecycleBin }),
    entry: (id) => call('entry.get', { id }),
    secret: (id, field) => call('entry.secret', { id, field }).then((r) => r.value),
    totp: (id) => call('entry.totp', { id }),
    historyEntry: (id, index) => call('entry.history', { id, index }),

    createEntry: (payload) => call('entry.create', payload),
    updateEntry: (payload) => call('entry.update', payload),
    deleteEntry: (id, permanent) => call('entry.delete', { id, permanent }),
    restoreEntry: (id, groupId) => call('entry.restore', { id, groupId }),
    moveEntry: (id, groupId) => call('entry.move', { id, groupId }),
    duplicateEntry: (id) => call('entry.duplicate', { id }),
    toggleFavorite: (id) => call('entry.favorite', { id }),
    restoreHistory: (id, index) => call('entry.restoreHistory', { id, index }),

    createGroup: (parentId, name) => call('group.create', { parentId, name }),
    updateGroup: (patch) => call('group.update', patch),
    deleteGroup: (id, permanent) => call('group.delete', { id, permanent }),
    moveGroup: (id, parentId) => call('group.move', { id, parentId }),
    emptyRecycleBin: () => call('recycle.empty'),

    addAttachment: (id) => call('attach.add', { id }),
    removeAttachment: (id, name) => call('attach.remove', { id, name }),
    saveAttachment: (id, name) => call('attach.save', { id, name }),

    audit: () => call('audit.run'),
    auditSimilar: (opts) => call('audit.similar', opts),
    auditPwned: () => call('audit.pwned'),

    setIcon: (id, base64, mime) => call('icon.set', { id, base64, mime }),
    clearIcon: (id) => call('icon.clear', { id }),
    favicon: (id) => call('icon.favicon', { id }),
    faviconAll: (overwrite) => call('icon.faviconAll', { overwrite }),

    expandField: (id, field) => call('entry.expand', { id, field }),
    setTotp: (opts) => call('totp.set', opts),
    removeTotp: (id) => call('totp.remove', { id }),
    totpUri: (id) => call('totp.uri', { id }),
    totpQr: (id) => call('totp.qr', { id }),

    compareDb: (opts) => call('db.compare', opts),
    mergeDb: (opts) => call('db.merge', opts),
    importEntries: (groupId) => call('db.import', { groupId }),
    exportEntries: (format) => call('db.export', { format }),
    copyEntriesTo: (opts) => call('db.copyEntriesTo', opts),
    chooseCompare: () => call('db.chooseCompare'),

    listBackups: () => call('backup.list'),
    restoreBackup: (name) => call('backup.restore', { name }),

    setReadOnly: (readOnly) => call('db.setReadOnly', { readOnly }),
    masterKeyAge: () => call('db.masterKeyAge'),

    securityStatus: (filePath) => call('security.status', { filePath }),
    setPin: (opts) => call('security.setPin', opts),
    clearPin: (filePath) => call('security.clearPin', { filePath }),
    setDuress: (opts) => call('security.setDuress', opts),
    clearDuress: (filePath) => call('security.clearDuress', { filePath }),
    setWipeAfterFails: (filePath, count) => call('security.setWipeAfterFails', { filePath, count }),
    setHello: (opts) => call('security.setHello', opts),
    helloAvailability: () => call('security.helloAvailability'),
    chooseDummy: () => call('security.chooseDummy'),

    pinUnlock: (filePath, pin) => call('db.pinUnlock', { filePath, pin }),
    helloUnlock: (filePath) => call('db.helloUnlock', { filePath }),

    remoteGet: (filePath) => call('remote.get', { filePath }),
    remoteSet: (filePath, config) => call('remote.set', { filePath, config }),
    remoteTest: (config) => call('remote.test', config),
    remoteSync: () => call('remote.sync'),
    chooseSshKey: () => call('remote.chooseKey'),

    sshStatus: () => call('ssh.status'),
    sshStart: () => call('ssh.start'),
    sshStop: () => call('ssh.stop'),
    sshReload: () => call('ssh.reload'),

    autoTypeNow: (sequence) => call('autotype.now', { sequence }),
    autoTypeWindow: () => call('autotype.window'),
    setAutoTypeSequence: (opts) => call('autotype.setSequence', opts),
    defaultSequence: () => call('autotype.defaultSequence'),

    generate: (config) => call('gen.make', config),
    usernames: () => call('gen.usernames'),
    clipboardRisk: () => call('clip.risk'),
    secretsVisible: (visible) => call('ui.secretsVisible', { visible }),
    wordLists: () => call('gen.wordLists'),
    strength: (password) => call('gen.strength', { password }),
    allTags: () => call('entries.tags'),

    checkUpdates: (manual) => call('update.check', { manual }),
    updateState: () => call('update.state'),
    downloadUpdate: () => call('update.download'),
    installUpdate: () => call('update.install'),
    openReleasePage: () => call('update.openReleasePage'),

    copy: (text) => call('clip.copy', { text }),
    copyField: (id, field) => call('clip.copyField', { id, field }),
    copyTotp: (id) => call('clip.copyTotp', { id }),
    clearClipboard: () => call('clip.clear'),
    openUrl: (url) => call('shell.openUrl', { url }),

    confirm: (opts) => call('ui.confirm', opts).then((r) => r.confirmed),
    errorBox: (opts) => call('ui.error', opts),

    on: (channel, fn) => bridge.on(channel, fn)
  };
})(window.IV);
