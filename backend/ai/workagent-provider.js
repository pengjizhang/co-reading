const { WorkAgentClient } = require('./workagent-client');
const { ReaderContextAdapter } = require('./reader-context-adapter');
const { AnswerNormalizer } = require('./answer-normalizer');

class WorkAgentProvider {
  constructor(options = {}) {
    this.client = options.client || new WorkAgentClient(options);
    this.contextAdapter = options.contextAdapter || new ReaderContextAdapter();
    this.normalizer = options.normalizer || new AnswerNormalizer();
    this.id = 'workagent';
  }

  configured() {
    return Boolean(this.client.enabled);
  }

  capabilities() {
    return {
      id: this.id,
      contextAdapter: this.contextAdapter.id,
      answerNormalizer: this.normalizer.id,
      ...this.client.capabilities(),
    };
  }

  async probe() {
    return {
      id: this.id,
      contextAdapter: this.contextAdapter.id,
      answerNormalizer: this.normalizer.id,
      ...await this.client.health({ force: true }),
    };
  }

  async answer(plan, contextPackage) {
    const request = this.contextAdapter.build(plan, contextPackage);
    const response = await this.client.run({
      content: request.prompt,
      mode: plan.mode,
      taskId: request.taskId,
      userId: plan.userId,
      tenantId: 'local',
      requestId: plan.id,
      signal: plan.signal,
    });
    return {
      ...this.normalizer.normalize(response.assistantMessage),
      _workagent: {
        traceId: response.traceId,
        taskId: response.taskId,
        jobId: response.jobId,
        model: response.model,
        elapsedMs: response.elapsedMs,
      },
    };
  }
}

module.exports = { WorkAgentProvider };
