FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /urt-gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /urt-gateway /urt-gateway
ENV URT_LISTEN=:8080 URT_WEB=/web
EXPOSE 8080 8443
ENTRYPOINT ["/urt-gateway"]
