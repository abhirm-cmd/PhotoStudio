/** Handles used by tests/e2e to drive the real app (only installed when PHOTOSTUDIO_TEST is set). */
import { useApp } from '../store/app';
import { useLibrary } from '../store/library';
import { useDevelop } from '../store/develop';
import { useView, host } from '../engine/host';
import { startExport, defaultExportSettings } from './exporter';
import { runAutoEnhance } from '../analysis/enhance';
import { loadReferenceImage, fitGrade, gradedEdit, describeLook } from '../analysis/referenceGrade';
import { generateMask } from '../analysis/segmentation';
import { createMask } from '../masking/maskOps';
import { analyzeAndTag } from '../analysis/tagging';
import { runUpright } from '../analysis/upright';
import { api } from '../api';

export function testHooks() {
  return { useApp, useLibrary, useDevelop, useView, host, startExport, defaultExportSettings, runAutoEnhance, loadReferenceImage, fitGrade, gradedEdit, describeLook, generateMask, createMask, analyzeAndTag, runUpright, api };
}
