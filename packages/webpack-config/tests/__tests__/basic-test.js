/* global page */
import getenv from 'getenv';
import config from '../../jest-puppeteer.config';

// We know that CI works in this process, but we want to test that it matches the process that our app runs in.
const isInCI = getenv.boolish('CI', false);

let response;
beforeEach(async () => {
  response = await page.goto(config.url);
});

it(`should match a text element`, async () => {
  await expect(page).toMatchElement('div[data-testid="basic-text"]', {
    text: 'Open up App.js to start working on your app!',
  });
});

if (config.hasServerSideRendering) {
  it(`should match a text element server-side`, async () => {
    const sourceCode = await response.text();
    expect(sourceCode).toEqual(
      expect.stringContaining('Open up App.js to start working on your app!')
    );
  });
}

describe('DefinePlugin', () => {
  it(`should be aware of process.env.CI`, async () => {
    const ciID = 'div[data-testid="has-ci-text"]';
    if (isInCI) {
      await expect(page).toMatchElement(ciID, {
        text: 'Has CI env',
      });
    } else {
      await expect(page).not.toMatchElement(ciID);
    }
  });
  it(`should have manifest from expo-constants`, async () => {
    await expect(page).toMatchElement('div[data-testid="expo-constants-manifest"]', {
      text: `A Neat Expo App`,
    });
  });

  if (config.hasServerSideRendering) {
    it(`should be aware of process.env.CI server-side`, async () => {
      const sourceCode = await response.text();
      if (isInCI) {
        expect(sourceCode).toEqual(expect.stringContaining('Has CI env'));
      } else {
        expect(sourceCode).not.toEqual(expect.stringContaining('Has CI env'));
      }
    });
    it(`should have manifest from expo-constants server-side`, async () => {
      const sourceCode = await response.text();
      expect(sourceCode).toEqual(expect.stringContaining(`A Neat Expo App`));
    });
  }
});
