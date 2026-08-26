import {
  checkPythonAIHealth,
} from "../src/services/python-ai.service";

async function main() {
  console.log("=".repeat(70));
  console.log("NODE → PYTHON AI SERVICE TEST");
  console.log("=".repeat(70));

  try {
    console.log("");
    console.log("1. Checking Python AI service...");

    const result =
      await checkPythonAIHealth();

    console.log(
      "[PASS] Python AI service reachable."
    );

    console.log("");
    console.log("Response:");
    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );

    if (
      result.success !== true
    ) {
      throw new Error(
        "Python AI health response is not successful."
      );
    }

    if (
      result.status !== "OK"
    ) {
      throw new Error(
        `Unexpected Python service status: ${String(
          result.status
        )}`
      );
    }

    console.log("");
    console.log("=".repeat(70));
    console.log(
      "NODE → PYTHON AI SERVICE TEST PASSED"
    );
    console.log("=".repeat(70));

    process.exit(0);
  } catch (error) {
    console.error("");
    console.error("=".repeat(70));
    console.error(
      "NODE → PYTHON AI SERVICE TEST FAILED"
    );
    console.error("=".repeat(70));

    console.error(
      error instanceof Error
        ? error.message
        : String(error)
    );

    process.exit(1);
  }
}

main();