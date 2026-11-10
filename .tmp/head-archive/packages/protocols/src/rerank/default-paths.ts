import type { RerankProtocol } from '../common/models.ts';

export const DEFAULT_RERANK_PATHS: Readonly<Record<RerankProtocol, string>> = {
  // Cohere SDK source: https://github.com/cohere-ai/cohere-python/blob/41f344bde2b195e0a7e51d259f4b3701e62605b5/src/cohere/raw_base_client.py#L1837-L1908
  'cohere-v1': '/v1/rerank',
  // Cohere SDK source: https://github.com/cohere-ai/cohere-python/blob/41f344bde2b195e0a7e51d259f4b3701e62605b5/src/cohere/v2/raw_client.py#L985-L1048
  'cohere-v2': '/v2/rerank',
  // Jina live OpenAPI: https://api.jina.ai/openapi.json
  'jina-v1': '/v1/rerank',
  // Voyage REST reference: https://docs.voyageai.com/reference/reranker-api.md
  'voyage-v1': '/v1/rerank',
  // DashScope compatible and native structures are deliberately separate:
  // https://help.aliyun.com/zh/model-studio/text-rerank-api
  'dashscope-compatible': '/compatible-api/v1/reranks',
  // DashScope SDK test pins both this path and the nested request body:
  // https://github.com/dashscope/dashscope-sdk-python/blob/f974f108526e87326b2b755b1586054d77a26679/tests/unit/test_rerank.py#L48-L65
  'dashscope-native': '/api/v1/services/rerank/text-rerank/text-rerank',
};
