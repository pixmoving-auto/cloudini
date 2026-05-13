# foxglove-cloudini-converter

A Foxglove extension to convert `Cloudini` compressed point clouds to a standard `PointCloud2` message. Originally developed by [Ascento AG](https://www.ascento.ai/).

## Usage

In this folder:

1. Build the single-file WASM module from the repo root:
   `emcmake cmake -B build/wasm -S ./cloudini_lib -DCLOUDINI_BUILD_TOOLS=OFF`
   `cmake --build build/wasm --target cloudini_wasm_single --parallel`
2. Run `npm install`
3. Build the extension with `npm run package`. This will automatically copy `../build/wasm/cloudini_wasm_single.js` into `src/` before packaging and should create `release/cloudini.foxglove-cloudini-converter-*.foxe`.
4. Open the extension manager in Foxglove: "Settings -> Extensions".
5. Drag and drop the `*.foxe` file into the extension manager.
