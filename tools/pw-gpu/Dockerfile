FROM mcr.microsoft.com/playwright:v1.55.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends mesa-vulkan-drivers libgl1-mesa-dri libegl1 libgles2 vulkan-tools mesa-utils && rm -rf /var/lib/apt/lists/*
