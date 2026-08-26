import time
from typing import Callable, Any


DEFAULT_RETRIES = 4
DEFAULT_DELAY = 3


def execute_with_retry(
    request,
    retries: int = DEFAULT_RETRIES,
    delay: int = DEFAULT_DELAY,
):
    """
    Execute a Google API request with retry handling.

    Handles temporary network/API failures without immediately
    terminating the complete catalog pipeline.
    """

    last_error = None

    for attempt in range(1, retries + 1):

        try:
            return request.execute()

        except Exception as error:

            last_error = error

            print()
            print(
                f"Google API request failed "
                f"(attempt {attempt}/{retries})"
            )

            print(
                f"Error: {error}"
            )

            if attempt < retries:

                wait_time = delay * attempt

                print(
                    f"Retrying in {wait_time} seconds..."
                )

                time.sleep(wait_time)

    raise last_error


def call_with_retry(
    function: Callable[..., Any],
    retries: int = DEFAULT_RETRIES,
    delay: int = DEFAULT_DELAY,
    *args,
    **kwargs,
):
    """
    Execute a normal Python function with retry handling.
    """

    last_error = None

    for attempt in range(1, retries + 1):

        try:
            return function(
                *args,
                **kwargs
            )

        except Exception as error:

            last_error = error

            print()
            print(
                f"Operation failed "
                f"(attempt {attempt}/{retries})"
            )

            print(
                f"Error: {error}"
            )

            if attempt < retries:

                wait_time = delay * attempt

                print(
                    f"Retrying in {wait_time} seconds..."
                )

                time.sleep(wait_time)

    raise last_error