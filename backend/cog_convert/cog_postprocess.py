import os
from .converter import convert_to_cog


def convert_job_to_cog(job_folder: str):

    if not os.path.exists(job_folder):
        raise FileNotFoundError(f"{job_folder} does not exist")

    print(f"\nStarting COG conversion for job: {job_folder}\n")

    for root, _, files in os.walk(job_folder):
        for file in files:
            if file.endswith(".tif"):
                tif_path = os.path.join(root, file)
                convert_to_cog(tif_path)

    print("\nCOG conversion completed.\n")
