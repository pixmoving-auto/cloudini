import { CompressedPointCloud, PointCloud, PointFieldDatatype } from "./Schemas";
import CloudiniModule from "./cloudini_wasm_single.js";
import type { CloudiniWasmModule } from "./cloudini_wasm_single";

let wasmModule: CloudiniWasmModule | null = null;
let wasmLoadingPromise: Promise<void> | null = null;

type PointField = PointCloud["fields"][number];

export const loadCloudiniWasm = async () => {
  if (!wasmLoadingPromise) {
    wasmLoadingPromise = CloudiniModule().then((module: CloudiniWasmModule) => {
      wasmModule = module;
    });
  }
  return wasmLoadingPromise;
};

const float16ToFloat32 = (value: number): number => {
  const sign = (value & 0x8000) !== 0 ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x03ff;

  if (exponent === 0) {
    if (fraction === 0) {
      return sign * 0;
    }
    return sign * 2 ** -14 * (fraction / 1024);
  }

  if (exponent === 0x1f) {
    if (fraction === 0) {
      return sign * Infinity;
    }
    return Number.NaN;
  }

  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

const isHalfFloatPointField = (field: PointField, expectedName: string, expectedOffset: number): boolean => {
  return (
    field.name === expectedName &&
    field.offset === expectedOffset &&
    field.count === 1 &&
    field.datatype === PointFieldDatatype.UINT16
  );
};

const isHalfFloatPointCloud = (decodedMsg: PointCloud, topic?: string): boolean => {
  const [xField, yField, zField, intensityField] = decodedMsg.fields;
  const matchesFields =
    decodedMsg.point_step === 8 &&
    decodedMsg.fields.length === 4 &&
    !!xField &&
    !!yField &&
    !!zField &&
    !!intensityField &&
    isHalfFloatPointField(xField, "x", 0) &&
    isHalfFloatPointField(yField, "y", 2) &&
    isHalfFloatPointField(zField, "z", 4) &&
    isHalfFloatPointField(intensityField, "intensity", 6);

  return matchesFields && (topic?.includes("half") ?? true);
};

const restoreHalfFloatPointCloud = (decodedMsg: PointCloud, topic?: string): PointCloud => {
  if (!isHalfFloatPointCloud(decodedMsg, topic)) {
    return decodedMsg;
  }

  const pointCount = decodedMsg.width * decodedMsg.height;
  const outputPointStep = 16;
  const outputData = new Uint8Array(pointCount * outputPointStep);
  const inputView = new DataView(decodedMsg.data.buffer, decodedMsg.data.byteOffset, decodedMsg.data.byteLength);
  const outputView = new DataView(outputData.buffer);

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const inputBase = pointIndex * decodedMsg.point_step;
    const outputBase = pointIndex * outputPointStep;

    outputView.setFloat32(outputBase + 0, float16ToFloat32(inputView.getUint16(inputBase + 0, true)), true);
    outputView.setFloat32(outputBase + 4, float16ToFloat32(inputView.getUint16(inputBase + 2, true)), true);
    outputView.setFloat32(outputBase + 8, float16ToFloat32(inputView.getUint16(inputBase + 4, true)), true);
    outputView.setFloat32(outputBase + 12, float16ToFloat32(inputView.getUint16(inputBase + 6, true)), true);
  }

  return {
    ...decodedMsg,
    fields: [
      { name: "x", offset: 0, datatype: PointFieldDatatype.FLOAT32, count: 1 },
      { name: "y", offset: 4, datatype: PointFieldDatatype.FLOAT32, count: 1 },
      { name: "z", offset: 8, datatype: PointFieldDatatype.FLOAT32, count: 1 },
      { name: "intensity", offset: 12, datatype: PointFieldDatatype.FLOAT32, count: 1 },
    ],
    point_step: outputPointStep,
    row_step: outputPointStep * decodedMsg.width,
    data: outputData,
  };
};

export const convertPointCloudWasm = (cloud: CompressedPointCloud, topic?: string): PointCloud => {
  if (!wasmModule) {
    loadCloudiniWasm();
    throw new Error('Cloudini WASM module is still loading. Please try again.');
  }


  const decodedMsg: PointCloud = {
    header: {
      frame_id: cloud.header.frame_id,
      stamp: cloud.header.stamp,
    },
    height: cloud.height,
    width: cloud.width,
    fields: cloud.fields,
    is_bigendian: false,
    point_step: cloud.point_step,
    row_step: cloud.point_step * cloud.width,
    is_dense: cloud.is_dense,
    data: new Uint8Array(),
  };

  // Nothing to do, the point cloud is empty
  if (cloud.width * cloud.height === 0) {
    return decodedMsg;
  }

  const data = cloud.compressed_data;

  let inputDataPtr: number | null = null;
  let outputDataPtr: number | null = null;

  try {

    const bufferSize = data.byteLength;

    // Check if data is too large for WASM memory
    if (wasmModule.HEAPU8) {
      const maxAllowedSize = wasmModule.HEAPU8.length / 4;
      if (bufferSize > maxAllowedSize) {
        throw new Error(`Message too large (${bufferSize} bytes > ${maxAllowedSize} bytes)`);
      }
    }

    // Allocate memory for input data
    inputDataPtr = wasmModule._malloc(bufferSize);
    if (!inputDataPtr) {
      throw new Error('Failed to allocate memory for input data');
    }

    const wasmInputView = new Uint8Array(wasmModule.HEAPU8.buffer, inputDataPtr, bufferSize);
    wasmInputView.set(data);

    const decompressedSize = cloud.height * cloud.width * cloud.point_step;

    outputDataPtr = wasmModule._malloc(decompressedSize);
    if (!outputDataPtr) {
      throw new Error('Failed to allocate memory for output data');
    }

    const actualSize = wasmModule._cldn_DecodeCompressedData(inputDataPtr, bufferSize, outputDataPtr);
    if (actualSize === 0) {
      throw new Error('Decompression failed - function returned 0');
    }

    if (actualSize !== decompressedSize) {
      console.warn(`Decompressed size mismatch: expected ${decompressedSize}, got ${actualSize}`);
    }

    // Copy the result to a JavaScript array
    const decodedData = new Uint8Array(wasmModule.HEAPU8.buffer, outputDataPtr, actualSize);
    // Create a copy to ensure data persists after memory is freed
    decodedMsg.data = new Uint8Array(decodedData);
  } catch (error) {
    console.error('Cloudini decompression failed:', error);
    // Preserve original frame_id and add error as a comment
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Cloudini decompression failed: ${errorMessage}`);
  } finally {
    if (inputDataPtr) wasmModule._free(inputDataPtr);
    if (outputDataPtr) wasmModule._free(outputDataPtr);
  }

  return restoreHalfFloatPointCloud(decodedMsg, topic);
};
