# Use a base image that supports x86 architecture
FROM debian:bullseye

# Install required packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-user-static \
    binfmt-support

# Enable ARM binary support
RUN update-binfmts --enable qemu-arm

# Copy the qemu-arm-static binary to the image
COPY qemu-arm-static /usr/bin/qemu-arm-static

# Copy your application files to the image
COPY . /app

# Set the working directory
WORKDIR /app

# Modify this line according to your actual build steps
# For example, if you're using Node.js
RUN apt-get install -y nodejs

# Build your application or perform other necessary steps
RUN npm install
# RUN npm run build

# Specify the command to run when the container starts
CMD ["npm", "run", "dist-all"]
