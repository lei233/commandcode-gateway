/**
 * 集中声明 DSH 运行时依赖边界：其余模块只从本文件导入，不直接引用包名。
 * 值导出与类型导出分开；sharp 只在 images.ts 直接引入。
 */
export {
  CommandCodeAdapter,
  DEFAULT_API_BASE,
  DEFAULT_GENERATE_MAX_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER,
} from '@mars-sea/dsh-commandcode-provider'

export type {
  CommandCodeAdapterDeps,
  CommandCodeConnectionOptions,
  ResolveAttachments,
} from '@mars-sea/dsh-commandcode-provider'

export {
  BlockAssembler,
  createAssistantMessage,
  createDeveloperMessage,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

export type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  ImageBlock,
  LlmModelInfo,
  Message,
  RequestMessage,
  StreamChunk,
  ToolSchema,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'

export type {
  AttachmentStore,
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageMediaType,
  ImageRequestTarget,
  RequestImageAttachment,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

export { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
