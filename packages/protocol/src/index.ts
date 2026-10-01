/**
 * Thoth protocol: wire-level types shared between the server and the
 * Obsidian plugin. The server is the source of truth; clients never
 * invent server state.
 */

export {
  AssetId,
  DeviceId,
  MAX_ASSET_BYTES,
  OperationId,
  OperationMetadata,
  ProtocolCapability,
  ProtocolVersion,
  Revision,
  VaultId,
} from './common.js';
export {
  RealtimeClientMessage,
  RealtimeServerMessage,
  WsTicketRequest,
  WsTicketResponse,
} from './realtime.js';
export {
  AddAssetOperation,
  AddAssetPayload,
  CreateNoteOperation,
  CreateNotePayload,
  DeleteAssetOperation,
  DeleteAssetPayload,
  DeleteNoteOperation,
  DeleteNotePayload,
  DeleteTextOperation,
  DeleteTextPayload,
  InsertTextOperation,
  InsertTextPayload,
  Operation,
  OperationType,
  RenameFolderOperation,
  RenameFolderPayload,
  RenameNoteOperation,
  RenameNotePayload,
  ReplaceContentOperation,
  ReplaceContentPayload,
  ReplaceRangeOperation,
  ReplaceRangePayload,
} from './operations.js';
export {
  CreateVaultRequest,
  ImportVaultRequest,
  PullOperationsRequest,
  PushOperationsRequest,
  RegisterDeviceRequest,
} from './requests.js';
export {
  CreateVaultResponse,
  DeviceListResponse,
  DeviceSummary,
  HealthResponse,
  PullOperationsResponse,
  PushOperationsResponse,
  RegisterDeviceResponse,
  VaultMetadataResponse,
  VersionResponse,
} from './responses.js';
export {
  ERROR_CODES,
  ErrorCode,
  ErrorResponse,
  ValidationErrorResponse,
  ValidationIssue,
} from './errors.js';
