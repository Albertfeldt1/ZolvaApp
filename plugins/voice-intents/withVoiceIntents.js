const fs = require('fs');
const path = require('path');
const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');

const SOURCES = [
  'Stone.swift',
  'SupabaseSession.swift',
  'SupabaseAuthClient.swift',
  'IntentActionClient.swift',
  'AskZolvaSnippetView.swift',
  'AskZolvaIntent.swift',
  'AskZolvaShortcuts.swift',
];

const copySources = (config) =>
  withDangerousMod(config, ['ios', async (cfg) => {
    const projectRoot = cfg.modRequest.projectRoot;
    const iosAppDir = path.join(cfg.modRequest.platformProjectRoot, 'Zolva');
    const srcDir = path.join(projectRoot, 'plugins', 'voice-intents');
    for (const file of SOURCES) {
      fs.copyFileSync(path.join(srcDir, file), path.join(iosAppDir, file));
    }
    return cfg;
  }]);

const registerInXcodeProject = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const targetUuid = project.findTargetKey('Zolva');
    if (!targetUuid) return cfg;
    for (const file of SOURCES) {
      const filePath = `Zolva/${file}`;
      const groupKey =
        project.findPBXGroupKey({ name: 'Zolva' }) ??
        project.pbxCreateGroup('Zolva', 'Zolva');
      project.addSourceFile(
        filePath,
        { target: targetUuid, lastKnownFileType: 'sourcecode.swift' },
        groupKey,
      );
    }
    return cfg;
  });

module.exports = (config) => {
  config = copySources(config);
  config = registerInXcodeProject(config);
  return config;
};
