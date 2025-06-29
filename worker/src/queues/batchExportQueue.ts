import { Job } from "bullmq";

import { BaseError, BatchExportStatus } from "@langfuse/shared";
import { kyselyPrisma } from "@langfuse/shared/src/db";

import {
  traceException,
  instrumentAsync,
  logger,
  recordIncrement,
  recordHistogram,
  getBatchExportQueue,
  recordGauge,
} from "@langfuse/shared/src/server";
import { QueueName, TQueueJobTypes } from "@langfuse/shared/src/server";
import { handleBatchExportJob } from "../features/batchExport/handleBatchExportJob";
import { SpanKind } from "@opentelemetry/api";

export const batchExportQueueProcessor = async (
  job: Job<TQueueJobTypes[QueueName.BatchExport]>
) => {
  return instrumentAsync(
    {
      name: "batchExportJobExecutor",
      spanKind: SpanKind.CONSUMER,
      traceContext: job.data?._tracecontext,
    },
    async () => {
      try {
        logger.info("Executing Batch Export Job", job.data.payload);

        const startTime = Date.now();

        const waitTime = Date.now() - job.timestamp;

        recordIncrement("batch_export_queue_request");
        recordHistogram("batch_export_queue_wait_time", waitTime, {
          unit: "milliseconds",
        });

        await handleBatchExportJob(job.data.payload);

        logger.info("Finished Batch Export Job", job.data.payload);

        await getBatchExportQueue()
          ?.count()
          .then((count) => {
            logger.debug(`Batch export queue length: ${count}`);
            recordGauge("batch_export_queue_length", count, {
              unit: "records",
            });
            return count;
          })
          .catch();
        recordHistogram(
          "batch_export_queue_processing_time",
          Date.now() - startTime,
          { unit: "milliseconds" }
        );

        return true;
      } catch (e) {
        const displayError =
          e instanceof BaseError ? e.message : "An internal error occurred";

        await kyselyPrisma.$kysely
          .updateTable("batch_exports")
          .set("status", BatchExportStatus.FAILED)
          .set("finished_at", new Date())
          .set("log", displayError)
          .where("id", "=", job.data.payload.batchExportId)
          .where("project_id", "=", job.data.payload.projectId)
          .execute();

        logger.error(
          `Failed Batch Export job for id ${job.data.payload.batchExportId}`,
          e
        );
        traceException(e);
        throw e;
      }
    }
  );
};
