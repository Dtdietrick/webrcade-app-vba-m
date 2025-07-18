import {
  blobToStr,
  md5,
  romNameScorer,
  setMessageAnchorId,
  settings,
  AppRegistry,
  FetchAppData,
  Resources,
  Unzip,
  UrlUtil,
  WebrcadeApp,
  APP_TYPE_KEYS,
  LOG,
  TEXT_IDS,
} from '@webrcade/app-common';
import { Emulator } from './emulator';
import { EmulatorPauseScreen } from './pause';

import './App.scss';

class App extends WebrcadeApp {
  emulator = null;
  rotValue = 0;
  rotSideways = false;
  isGba = false;

  componentDidMount() {
    super.componentDidMount();
    let { appProps, ModeEnum } = this;

    //feed based launch fix
    if (!appProps || !appProps.title || !appProps.rom || !appProps.type) {
      console.warn("appProps invalid — attempting to extract from feed.");

      try {
        const selectedItem = this.props?.feed?.getSelectedItem?.();
        if (selectedItem?.props) {
          appProps = {
            ...selectedItem.props,
            title: selectedItem.title,
            type: selectedItem.type,
          };
          console.log("Extracted appProps from feed:", appProps);
        }
      } catch (err) {
        console.error("Failed to patch appProps from feed:", err);
      }
    }
    // Set anchor for messages
    setMessageAnchorId('screen');

    try {
      // Get the ROM location that was specified
      const rom = appProps.rom;
      if (!rom) throw new Error('A ROM file was not specified.');

      // Get the ROM rotation (if applicable)
      const rot = appProps.rotation;
      if (rot) {
        const rotInt = parseInt(rot);
        if (!isNaN(rotInt)) {
          if (rotInt % 90 === 0) {
            this.rotValue = (rotInt / 90) % 4;
            if (this.rotValue % 2 !== 0) {
              this.rotSideways = true;
            }
          } else {
            LOG.error('rotation value is not a 90 degree value: ' + rot);
          }
        } else {
          LOG.error('rotation value is not a number: ' + rot);
        }
      }

      // Get flash size
      let flashSize = -1;
      const flash = appProps.flashSize;
      if (flash) {
        const flashInt = parseInt(flash);
        if (!isNaN(flashInt)) {
          flashSize = flash;
        } else {
          LOG.error('flashSize value is not a number: ' + flash);
        }
      }

      // Get save type
      let saveType = -1;
      const save = appProps.saveType;
      if (save) {
        const saveInt = parseInt(save);
        if (!isNaN(saveInt)) {
          saveType = save;
        } else {
          LOG.error('saveType value is not a number: ' + save);
        }
      }

      // Get RTC
      const rtc = appProps.rtc !== undefined ? appProps.rtc === true : false;

      // Get Mirroring
      const mirroring =
        appProps.mirroring !== undefined ? appProps.mirroring === true : false;

      // Get GB hardware type
      const gbHwType =
        appProps.hwType !== undefined ? parseInt(appProps.hwType) : 0;

      // Get GB colors
      const gbColors =
        appProps.colors !== undefined ? parseInt(appProps.colors) : 0;

      // Get GB palette
      const gbPalette =
        appProps.palette !== undefined ? parseInt(appProps.palette) : 0;

      // Get GB border
      const gbBorder =
        appProps.border !== undefined ? parseInt(appProps.border) : 0;

      // Disable cart lookup
      const disableLookup =
        appProps.disableLookup !== undefined ? appProps.disableLookup === true : false;

      // Get the type
      const type = appProps.type;
      if (!type) throw new Error('The application type was not specified.');
      this.isGba = type === APP_TYPE_KEYS.VBA_M_GBA;

      // Create the emulator
      if (this.emulator === null) {
        this.emulator = new Emulator(
          this,
          this.rotValue,
          this.isDebug(),
          flashSize,
          saveType,
          rtc,
          mirroring,
          disableLookup
        );
      }

      const { emulator } = this;

      // Expose emulator on global for external tools
      window.app = window.app || {};
      window.app.emulator = emulator;
      window.app.emulator.saveState = emulator.saveState?.bind(emulator);
      window.getSaveStateBlob = window.wrc.getSaveBlob;

      // Determine extensions
      const exts = [
        ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GBA, true, false),
        ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GB, true, false),
        ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GBC, true, false),
      ];
      const extsNotUnique = [
        ...new Set([
          ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GBA, true, true),
          ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GB, true, true),
          ...AppRegistry.instance.getExtensions(APP_TYPE_KEYS.VBA_M_GBC, true, true),
        ]),
      ];

      // Load emscripten and the ROM
      const uz = new Unzip().setDebug(this.isDebug());
      let romBlob = null;
      let romMd5 = null;
      emulator
        .loadEmscriptenModule()
        .then(() => settings.load())
        // .then(() => settings.setBilinearFilterEnabled(true))
        // .then(() => settings.setVsyncEnabled(false))
        .then(() => new FetchAppData(rom).fetch())
        .then((response) => {
          LOG.info('downloaded.');
          return response.blob();
        })
        .then((blob) => uz.unzip(blob, extsNotUnique, exts, romNameScorer))
        .then((blob) => {
          romBlob = blob;
          return blob;
        })
        .then((blob) => blobToStr(blob))
        .then((str) => {
          romMd5 = md5(str);
          emulator.romMd5 = romMd5;
          console.log("🔬 Calculated new MD5:", romMd5);
        })
        .then(() => new Response(romBlob).arrayBuffer())
        .then((bytes) =>
          emulator.setRom(
            this.isGba,
            type,
            uz.getName() ? uz.getName() : UrlUtil.getFileName(rom),
            bytes,
            romMd5,
            type === APP_TYPE_KEYS.VBA_M_GB ? gbHwType : 1,
            gbColors,
            gbPalette,
            gbBorder,
          )
        )
        .then(() => this.setState({ mode: ModeEnum.LOADED }))
        .then(() => {
          // Setup external save manager hooks
          const saveManager = emulator.saveManager;
          const module = emulator?.module || saveManager?.module || window.Module;
          const title = emulator.getTitle?.();
          const FS = module?.FS;

          window._mod = module;
          window.FS = FS;

          window.wrc = {
            getSaveManager: () => saveManager,
            getSaveBlob: async () => {
              try {
                const id = saveManager.getId?.(title, type, romMd5);
                const files = await saveManager.loadLocal(title);
                return files ? await saveManager.createZip(files) : null;
              } catch (err) {
                return null;
              }
            },
            flushSaveData: () => {
              try {
                if (saveManager?.flush) {
                  saveManager.flush();
                  if (window.FS?.syncfs) {
                    window.FS.syncfs(false, (err) => {
                      if (err) console.error("FS.syncfs failed:", err);
                    });
                  }
                }
              } catch (err) {
                console.error("flushSaveData error:", err);
              }
            }
          };
        })
        .catch((msg) => {
          LOG.error(msg);
          this.exit(
            this.isDebug()
              ? msg
              : Resources.getText(TEXT_IDS.ERROR_RETRIEVING_GAME)
          );
        });

    } catch (e) {
      this.exit(e);
    }
  }

  async onPreExit() {
    try {
      await super.onPreExit();
      if (!this.isExitFromPause()) {
        await this.emulator.saveState();
      }
    } catch (e) {
      LOG.error(e);
    }
  }

  componentDidUpdate() {
    const { mode } = this.state;
    const { canvas, emulator, ModeEnum } = this;

    if (mode === ModeEnum.LOADED) {
      window.focus();
      // Start the emulator
      emulator.start(canvas);
    }
  }

  renderPauseScreen() {
    const { appProps, emulator } = this;

    return (
      <EmulatorPauseScreen
        type={this.getAppType()}
        emulator={emulator}
        appProps={appProps}
        closeCallback={() => this.resume()}
        exitCallback={() => this.exitFromPause()}
        isEditor={this.isEditor}
        isStandalone={this.isStandalone}
      />
    );
  }

  renderCanvas() {
    const { rotValue, rotSideways } = this;

    let className = '';
    if (rotValue !== 0) {
      className += 'rotate' + 90 * rotValue;
    }
    if (rotSideways) {
      if (className.length > 0) {
        className += ' ';
      }
      className += 'sideways';
    }
    if (!this.isGba) {
      if (className.length > 0) {
        className += ' ';
      }
      className += 'screen-gb';
    }
    return (
      <canvas
        style={this.getCanvasStyles()}
        className={className}
        ref={(canvas) => {
          this.canvas = canvas;
        }}
        id="screen"
      ></canvas>
    );
  }

  render() {
    const { mode } = this.state;
    const { ModeEnum } = this;

    return (
      <>
        {super.render()}
        {mode === ModeEnum.LOADING ? this.renderLoading() : null}
        {mode === ModeEnum.PAUSE ? this.renderPauseScreen() : null}
        {mode === ModeEnum.LOADED || mode === ModeEnum.PAUSE
          ? this.renderCanvas()
          : null}
      </>
    );
  }
}

export default App;