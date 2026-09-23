export const CLI_COMMAND_NAME = "qcode";
export const CLI_PROCESS_NAME = "qcode-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
