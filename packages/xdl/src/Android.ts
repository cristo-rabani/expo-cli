import { readConfigJsonAsync, readExpRcAsync } from '@expo/config';
import spawnAsync from '@expo/spawn-async';
import chalk from 'chalk';
import fs from 'fs-extra';
import _ from 'lodash';
import path from 'path';
import semver from 'semver';

import * as Analytics from './Analytics';
import Api from './Api';
import * as Binaries from './Binaries';
import Logger from './Logger';
import NotificationCode from './NotificationCode';
import * as ProjectSettings from './ProjectSettings';
import { getImageDimensionsAsync } from './tools/ImageUtils';
import * as UrlUtils from './UrlUtils';
import UserSettings from './UserSettings';
import * as Versions from './Versions';
import { getUrlAsync as getWebpackUrlAsync } from './Webpack';

let _lastUrl: string | null = null;
const BEGINNING_OF_ADB_ERROR_MESSAGE = 'error: ';
const CANT_START_ACTIVITY_ERROR = 'Activity not started, unable to resolve Intent';

export function isPlatformSupported(): boolean {
  return (
    process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
  );
}

export async function getAdbOutputAsync(args: string[]): Promise<string> {
  await Binaries.addToPathAsync('adb');

  try {
    let result = await spawnAsync('adb', args);
    return result.stdout;
  } catch (e) {
    let errorMessage = _.trim(e.stderr);
    if (errorMessage.startsWith(BEGINNING_OF_ADB_ERROR_MESSAGE)) {
      errorMessage = errorMessage.substring(BEGINNING_OF_ADB_ERROR_MESSAGE.length);
    }
    throw new Error(errorMessage);
  }
}

// Device attached
async function _isDeviceAttachedAsync() {
  let devices = await getAdbOutputAsync(['devices']);
  let lines = _.trim(devices).split(/\r?\n/);
  // First line is "List of devices".
  return lines.length > 1;
}

async function _isDeviceAuthorizedAsync() {
  let devices = await getAdbOutputAsync(['devices']);
  let lines = _.trim(devices).split(/\r?\n/);
  lines.shift();
  let listOfDevicesWithoutFirstLine = lines.join('\n');
  // result looks like "072c4cf200e333c7  device" when authorized
  // and "072c4cf200e333c7  unauthorized" when not.
  return listOfDevicesWithoutFirstLine.includes('device');
}

// Expo installed
async function _isExpoInstalledAsync() {
  let packages = await getAdbOutputAsync(['shell', 'pm', 'list', 'packages', '-f']);
  let lines = packages.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes('host.exp.exponent.test')) {
      continue;
    }

    if (line.includes('host.exp.exponent')) {
      return true;
    }
  }

  return false;
}

async function _expoVersionAsync() {
  let info = await getAdbOutputAsync(['shell', 'dumpsys', 'package', 'host.exp.exponent']);

  let regex = /versionName=([0-9.]+)/;
  let regexMatch = regex.exec(info);
  if (!regexMatch || regexMatch.length < 2) {
    return null;
  }

  return regexMatch[1];
}

async function _checkExpoUpToDateAsync() {
  let versions = await Versions.versionsAsync();
  let installedVersion = await _expoVersionAsync();

  if (!installedVersion || semver.lt(installedVersion, versions.androidVersion)) {
    Logger.notifications.warn(
      { code: NotificationCode.OLD_ANDROID_APP_VERSION },
      'This version of the Expo app is out of date. Uninstall the app and run again to upgrade.'
    );
  }
}

function _apkCacheDirectory() {
  let dotExpoHomeDirectory = UserSettings.dotExpoHomeDirectory();
  let dir = path.join(dotExpoHomeDirectory, 'android-apk-cache');
  fs.mkdirpSync(dir);
  return dir;
}

export async function downloadApkAsync(url?: string) {
  let versions = await Versions.versionsAsync();
  let apkPath = path.join(_apkCacheDirectory(), `Exponent-${versions.androidVersion}.apk`);

  if (await fs.pathExists(apkPath)) {
    return apkPath;
  }

  await Api.downloadAsync(
    url || versions.androidUrl,
    path.join(_apkCacheDirectory(), `Exponent-${versions.androidVersion}.apk`)
  );
  return apkPath;
}

export async function installExpoAsync(url?: string) {
  Logger.global.info(`Downloading latest version of Expo`);
  Logger.notifications.info({ code: NotificationCode.START_LOADING });
  let path = await downloadApkAsync(url);
  Logger.notifications.info({ code: NotificationCode.STOP_LOADING });
  Logger.global.info(`Installing Expo on device`);
  Logger.notifications.info({ code: NotificationCode.START_LOADING });
  let result = await getAdbOutputAsync(['install', path]);
  Logger.notifications.info({ code: NotificationCode.STOP_LOADING });
  return result;
}

export async function uninstallExpoAsync() {
  Logger.global.info('Uninstalling Expo from Android device.');
  return await getAdbOutputAsync(['uninstall', 'host.exp.exponent']);
}

export async function upgradeExpoAsync(): Promise<boolean> {
  try {
    await assertDeviceReadyAsync();

    await uninstallExpoAsync();
    await installExpoAsync();
    if (_lastUrl) {
      Logger.global.info(`Opening ${_lastUrl} in Expo.`);
      await getAdbOutputAsync([
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        _lastUrl,
      ]);
      _lastUrl = null;
    }

    return true;
  } catch (e) {
    Logger.global.error(e.message);
    return false;
  }
}

// Open Url
export async function assertDeviceReadyAsync() {
  const genymotionMessage = `https://developer.android.com/studio/run/device.html#developer-device-options. If you are using Genymotion go to Settings -> ADB, select "Use custom Android SDK tools", and point it at your Android SDK directory.`;

  if (!(await _isDeviceAttachedAsync())) {
    throw new Error(
      `No Android device found. Please connect a device and follow the instructions here to enable USB debugging:\n${genymotionMessage}`
    );
  }

  if (!(await _isDeviceAuthorizedAsync())) {
    throw new Error(
      `This computer is not authorized to debug the device. Please follow the instructions here to enable USB debugging:\n${genymotionMessage}`
    );
  }
}

async function _openUrlAsync(url: string) {
  let output = await getAdbOutputAsync([
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    url,
  ]);
  if (output.includes(CANT_START_ACTIVITY_ERROR)) {
    throw new Error(output.substring(output.indexOf('Error: ')));
  }

  return output;
}

async function openUrlAsync(url: string, isDetached: boolean = false): Promise<void> {
  try {
    await assertDeviceReadyAsync();

    let installedExpo = false;
    if (!isDetached && !(await _isExpoInstalledAsync())) {
      await installExpoAsync();
      installedExpo = true;
    }

    if (!isDetached) {
      _lastUrl = url;
      _checkExpoUpToDateAsync(); // let this run in background
    }

    Logger.global.info(`Opening on Android device`);
    try {
      await _openUrlAsync(url);
    } catch (e) {
      if (isDetached) {
        e.message = `Error running app. Have you installed the app already using Android Studio? Since you are detached you must build manually. ${
          e.message
        }`;
      } else {
        e.message = `Error running app. ${e.message}`;
      }

      throw e;
    }

    Analytics.logEvent('Open Url on Device', {
      platform: 'android',
      installedExpo,
    });
  } catch (e) {
    e.message = `Error running adb: ${e.message}`;
    throw e;
  }
}

export async function openProjectAsync(
  projectRoot: string
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    await startAdbReverseAsync(projectRoot);

    let projectUrl = await UrlUtils.constructManifestUrlAsync(projectRoot);
    let { exp } = await readConfigJsonAsync(projectRoot);

    await openUrlAsync(projectUrl, !!exp.isDetached);
    return { success: true, url: projectUrl };
  } catch (e) {
    Logger.global.error(`Couldn't start project on Android: ${e.message}`);
    return { success: false, error: e };
  }
}

export async function openWebProjectAsync(
  projectRoot: string
): Promise<{ success: true; url: string } | { success: false; error: string }> {
  try {
    await startAdbReverseAsync(projectRoot);

    const projectUrl = await getWebpackUrlAsync(projectRoot);
    if (projectUrl === null) {
      return {
        success: false,
        error: `The web project has not been started yet`,
      };
    }
    await openUrlAsync(projectUrl, true);
    return { success: true, url: projectUrl };
  } catch (e) {
    Logger.global.error(`Couldn't open the web project on Android: ${e.message}`);
    return { success: false, error: e };
  }
}

// Adb reverse
export async function startAdbReverseAsync(projectRoot: string): Promise<boolean> {
  const packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  const expRc = await readExpRcAsync(projectRoot);
  const userDefinedAdbReversePorts = expRc.extraAdbReversePorts || [];

  let adbReversePorts = [
    packagerInfo.packagerPort,
    packagerInfo.expoServerPort,
    ...userDefinedAdbReversePorts,
  ];

  for (let port of adbReversePorts) {
    if (!(await adbReverse(port))) {
      return false;
    }
  }

  return true;
}

export async function stopAdbReverseAsync(projectRoot: string): Promise<void> {
  const packagerInfo = await ProjectSettings.readPackagerInfoAsync(projectRoot);
  const expRc = await readExpRcAsync(projectRoot);
  const userDefinedAdbReversePorts = expRc.extraAdbReversePorts || [];

  let adbReversePorts = [
    packagerInfo.packagerPort,
    packagerInfo.expoServerPort,
    ...userDefinedAdbReversePorts,
  ];

  for (let port of adbReversePorts) {
    await adbReverseRemove(port);
  }
}

async function adbReverse(port: number) {
  if (!(await _isDeviceAuthorizedAsync())) {
    return false;
  }

  try {
    await getAdbOutputAsync(['reverse', `tcp:${port}`, `tcp:${port}`]);
    return true;
  } catch (e) {
    Logger.global.warn(`Couldn't adb reverse: ${e.message}`);
    return false;
  }
}

async function adbReverseRemove(port: number) {
  if (!(await _isDeviceAuthorizedAsync())) {
    return false;
  }

  try {
    await getAdbOutputAsync(['reverse', '--remove', `tcp:${port}`]);
    return true;
  } catch (e) {
    // Don't send this to warn because we call this preemptively sometimes
    Logger.global.debug(`Couldn't adb reverse remove: ${e.message}`);
    return false;
  }
}

const splashScreenDPIConstraints = [
  {
    dpi: 'mdpi',
    sizeMultiplier: 1,
  },
  {
    dpi: 'hdpi',
    sizeMultiplier: 1.5,
  },
  {
    dpi: 'xhdpi',
    sizeMultiplier: 2,
  },
  {
    dpi: 'xxhdpi',
    sizeMultiplier: 3,
  },
  {
    dpi: 'xxxhdpi',
    sizeMultiplier: 4,
  },
];

/**
 * Checks whether `resizeMode` is set to `native` and if `true` analyzes provided images for splashscreen
 * providing `Logger` feedback upon problems.
 * @param projectDir - directory of the expo project
 * @since SDK33
 */
export async function checkSplashScreenImages(projectDir: string): Promise<void> {
  const { exp } = await readConfigJsonAsync(projectDir);

  // return before SDK33
  if (!Versions.gteSdkVersion(exp, '33.0.0')) {
    return;
  }

  const splashScreenMode =
    _.get(exp, 'android.splash.resizeMode') || _.get(exp, 'splash.resizeMode', 'contain');

  // only mode `native` is handled by this check
  if (splashScreenMode === 'contain' || splashScreenMode === 'cover') {
    return;
  }

  const generalSplashImagePath = _.get(exp, 'splash.image');
  if (!generalSplashImagePath) {
    Logger.global.warn(
      `Couldn't read '${chalk.italic('splash.image')}' from ${chalk.italic(
        'app.json'
      )}. Provide asset that would serve as baseline splash image.`
    );
    return;
  }
  const generalSplashImage = await getImageDimensionsAsync(projectDir, generalSplashImagePath);
  if (!generalSplashImage) {
    Logger.global.warn(
      `Couldn't read dimensions of provided splash image '${chalk.italic(
        generalSplashImagePath
      )}'. Does the file exist?`
    );
    return;
  }

  const androidSplash = _.get(exp, 'android.splash');
  const androidSplashImages = [];
  for (const { dpi, sizeMultiplier } of splashScreenDPIConstraints) {
    const imageRelativePath = _.get(androidSplash, dpi);
    if (imageRelativePath) {
      const splashImage = await getImageDimensionsAsync(projectDir, imageRelativePath);
      if (!splashImage) {
        Logger.global.warn(
          `Couldn't read dimensions of provided splash image '${chalk.italic(
            imageRelativePath
          )}'. Does the file exist?`
        );
        continue;
      }
      const { width, height } = splashImage;
      const expectedWidth = sizeMultiplier * generalSplashImage.width;
      const expectedHeight = sizeMultiplier * generalSplashImage.height;
      androidSplashImages.push({
        dpi,
        width,
        height,
        expectedWidth,
        expectedHeight,
        sizeMatches: width === expectedWidth && height === expectedHeight,
      });
    }
  }

  if (androidSplashImages.length === 0) {
    Logger.global
      .warn(`Splash resizeMode is set to 'native', but you haven't provided any images for different DPIs.
Be aware that your splash image will be used as xxxhdpi asset and its ${chalk.bold(
      'actual size will be different'
    )} depending on device's DPI.
See https://docs.expo.io/versions/latest/guides/splash-screens/#differences-between-environments---android for more information`);
    return;
  }

  if (_.some(androidSplashImages, ({ sizeMatches }) => !sizeMatches)) {
    Logger.global
      .warn(`Splash resizeMode is set to 'native' and you've provided different images for different DPIs,
but their sizes mismatch expected ones: [dpi: provided (expected)] ${androidSplashImages
      .map(
        ({ dpi, width, height, expectedWidth, expectedHeight }) =>
          `${dpi}: ${width}x${height} (${expectedWidth}x${expectedHeight})`
      )
      .join(', ')}
See https://docs.expo.io/versions/latest/guides/splash-screens/#differences-between-environments---android for more information`);
  }
}
